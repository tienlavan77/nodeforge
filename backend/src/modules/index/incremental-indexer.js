import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { createDependencyGraph } from "./dependency-graph.js";
import { createFileRepository } from "./file-repository.js";
import { extractorRegistry } from "./parser/index.js";
import { readContentHash } from "../watcher/debounced-watcher.js";
import { logEvent } from "../../core/project-log-service.js";

export function createIncrementalIndexer({ database, projectRoot, registry = extractorRegistry, files = createFileRepository(database), graph = createDependencyGraph({ database, files, projectRoot }), fileService, getContentHash = readContentHash, logger = console, projectLogger = logEvent } = {}) {
  return Object.freeze({
    async handle(event) {
      const path = event.payload?.path;
      if (!path) return false;
      writeLog("index.started", "info", "Index operation started.", event, path);

      try {
        if (event.type === "watcher.file_created") return indexNewFile(path, event);
        if (event.type === "watcher.file_modified") return reindexFile(path, event);
        if (event.type === "watcher.file_deleted") return deleteFile(path, event);
        if (event.type === "watcher.file_renamed") return renameFile(event.payload.old_path, path, event);
        return false;
      } catch (error) {
        writeLog("index.failed", "error", error.message, event, path);
        throw error;
      }
    }
  });

  async function indexNewFile(path, event) {
    const snapshot = await readSnapshot(path);
    const sha256 = snapshot?.sha256;
    const sizeBytes = snapshot?.size_bytes;
    if (!sha256) { writeLog("index.skipped", "info", "File content unavailable; index skipped.", event, path); return false; }
    const extraction = await extract(path, snapshot.content);
    if (!extraction) { writeLog("index.failed", "error", "File extraction failed.", event, path); return false; }
    let fileId;
    withTransaction(() => {
      fileId = files.insert(path, { language: languageForPath(path), sha256, sizeBytes });
      // Created events can be delivered by more than one watcher process.
      // Replace derived rows so replay remains idempotent after the upsert.
      database.run("DELETE FROM symbols WHERE file_id = ?", [fileId]);
      database.run("DELETE FROM imports_exports WHERE file_id = ?", [fileId]);
      database.run("DELETE FROM calls WHERE source_file_id = ?", [fileId]);
      clearContentIndex(fileId);
      writeExtraction(fileId, path, extraction);
      indexContent(fileId, path, snapshot.content);
      graph.replaceForFile(fileId, path, extraction.imports);
      writeCalls(fileId, path, extraction);
      database.run("UPDATE index_metadata SET version = version + 1");
    });
    writeLog("index.completed", "info", "File indexed.", event, path, "success");
    return true;
  }

  async function reindexFile(path, event) {
    const file = files.findByPath(path);
    if (!file) return indexNewFile(path, event);

    const snapshot = await readSnapshot(path);
    const sha256 = snapshot?.sha256;
    const sizeBytes = snapshot?.size_bytes;
    if (!sha256) { writeLog("index.skipped", "info", "File content unavailable; index skipped.", event, path); return false; }
    const extraction = await extract(path, snapshot.content);
    if (!extraction) {
      writeLog("index.failed", "error", "File extraction failed; prior index retained.", event, path);
      // Keep the index content marked with the latest hash even when parsing fails.
      files.updateHash(file.file_id, sha256, sizeBytes, languageForPath(path));
      return false;
    }
    withTransaction(() => {
      database.run("DELETE FROM symbols WHERE file_id = ?", [file.file_id]);
      database.run("DELETE FROM imports_exports WHERE file_id = ?", [file.file_id]);
      database.run("DELETE FROM calls WHERE source_file_id = ?", [file.file_id]);
      clearContentIndex(file.file_id);
      files.updateHash(file.file_id, sha256, sizeBytes, languageForPath(path));
      writeExtraction(file.file_id, path, extraction);
      indexContent(file.file_id, path, snapshot.content);
      graph.replaceForFile(file.file_id, path, extraction.imports);
      writeCalls(file.file_id, path, extraction);
      database.run("UPDATE index_metadata SET version = version + 1");
    });
    writeLog("index.completed", "info", "File index updated.", event, path, "success");
    return true;
  }

  function deleteFile(path, event) {
    const file = files.findByPath(path);
    if (!file) return false;

    database.run("UPDATE imports_exports SET is_broken = 1 WHERE related_file_id = ?", [file.file_id]);
    graph.markTargetBroken(file.file_id);
    clearContentIndex(file.file_id);
    const removed = files.remove(file.file_id);
    if (removed) database.run("UPDATE index_metadata SET version = version + 1");
    writeLog(removed ? "index.completed" : "index.skipped", "info", removed ? "File removed from index." : "File was not indexed.", event, path, removed ? "success" : "info");
    return removed;
  }

  function renameFile(oldPath, newPath, event) {
    if (!oldPath) return false;
    const file = files.findByPath(oldPath);
    const renamed = file ? files.rename(file.file_id, newPath) : false;
    if (renamed) database.run("UPDATE index_metadata SET version = version + 1");
    writeLog(renamed ? "index.completed" : "index.skipped", "info", renamed ? "File renamed in index." : "Rename skipped.", event, newPath, renamed ? "success" : "info");
    return renamed;
  }

  function writeLog(eventName, level, message, event, path, status = level === "error" ? "failed" : "info") {
    try { projectLogger({ timestamp: new Date().toISOString(), event_name: eventName, level, status, message, task_id: event?.task_id ?? event?.payload?.task_id ?? `INDEX-${path}`, ticket_id: event?.ticket_id ?? event?.payload?.ticket_id, conversation_id: event?.conversation_id ?? event?.payload?.conversation_id, source: "incremental-indexer" }); } catch (error) { logger.warning?.("Project log write failed.", { error: error.message, path }); }
  }

  function withTransaction(operation) {
    if (typeof database.transaction === "function") return database.transaction(operation);
    database.run("BEGIN");
    try { const result = operation(); database.run("COMMIT"); return result; } catch (error) { database.run("ROLLBACK"); throw error; }
  }

  async function extract(path, content) {
    const absolutePath = resolve(projectRoot, path);
    try {
      return registry.extract(absolutePath, content ?? await readFile(absolutePath, "utf8"));
    } catch (error) {
      logger.warning?.("Index extraction failed; retaining the prior index entry.", { path, error: error.message });
      return null;
    }
  }

  async function readSnapshot(path) {
    if (fileService?.readForIndex) return fileService.readForIndex({ path });
    const absolutePath = resolve(projectRoot, path);
    const content = await readFile(absolutePath, "utf8");
    return { content, sha256: await hash(path), size_bytes: await fileSize(path), language: languageForPath(path) };
  }

  function hash(path) {
    return getContentHash(resolve(projectRoot, path));
  }

  async function fileSize(path) {
    try { return (await stat(resolve(projectRoot, path))).size; } catch { return null; }
  }

  function writeExtraction(fileId, path, extraction) {
    for (const symbol of extraction.symbols) {
      database.run(
        "INSERT INTO symbols (symbol_id, file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)",
        [createRecordId("SYM"), fileId, symbol.name, symbol.kind, symbol.start_line, symbol.end_line]
      );
    }
    for (const item of extraction.imports) writeRelation(fileId, path, item, item.imported ?? item.source, item.kind);
    for (const item of extraction.exports) writeRelation(fileId, path, item, item.name, `export:${item.kind}`);
  }

  function clearContentIndex(fileId) {
    database.run("DELETE FROM file_content_fts WHERE file_id = ?", [fileId]);
    database.run("DELETE FROM symbol_content_fts WHERE file_id = ?", [fileId]);
  }

  function indexContent(fileId, path, content) {
    if (typeof content !== "string") return;
    database.run("INSERT INTO file_content_fts (file_id, path, language, content) VALUES (?, ?, ?, ?)", [fileId, path, languageForPath(path), content]);
    const lines = content.split(/\r?\n/);
    const rows = database.all("SELECT symbol_id, name, kind, start_line, end_line FROM symbols WHERE file_id = ? ORDER BY start_line, name", [fileId]);
    for (const symbol of rows) {
      const start = Math.max(1, symbol.start_line ?? 1);
      const end = Math.min(lines.length, Math.max(start, symbol.end_line ?? start));
      database.run("INSERT INTO symbol_content_fts (symbol_id, file_id, path, name, kind, content, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [symbol.symbol_id, fileId, path, symbol.name, symbol.kind, lines.slice(start - 1, end).join("\n"), symbol.start_line, symbol.end_line]);
    }
  }

  function writeRelation(fileId, path, item, name, kind) {
    const relatedFileId = graph.resolve(path, item.source, item.external);
    const isBroken = Number(!item.external && item.source && !relatedFileId);
    database.run(
      "INSERT INTO imports_exports (relation_id, file_id, related_file_id, name, kind, is_broken) VALUES (?, ?, ?, ?, ?, ?)",
      [createRecordId("REL"), fileId, relatedFileId, name, kind, isBroken]
    );
  }

  function writeCalls(fileId, path, extraction) {
    for (const call of extraction.calls) {
      const targetSymbolId = resolveCallTarget(fileId, path, call, extraction.imports);
      if (!targetSymbolId) continue;
      const callerSymbolId = call.caller_symbol ? findSymbolId(fileId, call.caller_symbol) : null;
      database.run(
        "INSERT INTO calls (call_id, source_file_id, caller_symbol_id, target_symbol_id, line) VALUES (?, ?, ?, ?, ?)",
        [createRecordId("CALL"), fileId, callerSymbolId, targetSymbolId, call.line]
      );
    }
  }

  function resolveCallTarget(fileId, path, call, imports) {
    const localTarget = findSymbolId(fileId, call.callee_name);
    if (localTarget) return localTarget;

    const imported = imports.find((item) => item.local === call.callee_name);
    if (imported) {
      const targetFileId = graph.resolve(path, imported.source, imported.external);
      return targetFileId ? findSymbolId(targetFileId, imported.imported) : null;
    }

    // A static PHP require imports the target file's declarations without a local alias.
    for (const required of imports.filter((item) => item.kind === "require")) {
      const targetFileId = graph.resolve(path, required.source, required.external);
      const targetSymbolId = targetFileId ? findSymbolId(targetFileId, call.callee_name) : null;
      if (targetSymbolId) return targetSymbolId;
    }
    return null;
  }

  function findSymbolId(fileId, name) {
    if (!name) return null;
    return database.all("SELECT symbol_id FROM symbols WHERE file_id = ? AND name = ? LIMIT 1", [fileId, name])[0]?.symbol_id ?? null;
  }

}

function languageForPath(path) {
  const extension = extname(path).toLowerCase();
  return { ".js": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".php": "php" }[extension] ?? null;
}

function createRecordId(prefix) {
  return `${prefix}-${randomUUID()}`;
}
