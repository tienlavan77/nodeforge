import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createDependencyGraph } from "./dependency-graph.js";
import { createFileRepository } from "./file-repository.js";
import { extractorRegistry } from "./parser/index.js";
import { readContentHash } from "../watcher/debounced-watcher.js";

export function createIncrementalIndexer({ database, projectRoot, registry = extractorRegistry, files = createFileRepository(database), graph = createDependencyGraph({ database, files, projectRoot }), getContentHash = readContentHash, logger = console } = {}) {
  return Object.freeze({
    async handle(event) {
      const path = event.payload?.path;
      if (!path) return false;

      if (event.type === "watcher.file_created") return indexNewFile(path);
      if (event.type === "watcher.file_modified") return reindexFile(path);
      if (event.type === "watcher.file_deleted") return deleteFile(path);
      if (event.type === "watcher.file_renamed") return renameFile(event.payload.old_path, path);
      return false;
    }
  });

  async function indexNewFile(path) {
    const sha256 = await hash(path);
    if (!sha256) return false;
    const extraction = await extract(path);
    if (!extraction) return false;
    let fileId;
    withTransaction(() => {
      fileId = files.insert(path, { sha256 });
      writeExtraction(fileId, path, extraction);
      graph.replaceForFile(fileId, path, extraction.imports);
      writeCalls(fileId, path, extraction);
    });
    return true;
  }

  async function reindexFile(path) {
    const file = files.findByPath(path);
    if (!file) return indexNewFile(path);

    const sha256 = await hash(path);
    if (!sha256) return false;
    const extraction = await extract(path);
    if (!extraction) {
      // Keep the index content marked with the latest hash even when parsing fails.
      files.updateHash(file.file_id, sha256);
      return false;
    }
    withTransaction(() => {
      database.run("DELETE FROM symbols WHERE file_id = ?", [file.file_id]);
      database.run("DELETE FROM imports_exports WHERE file_id = ?", [file.file_id]);
      database.run("DELETE FROM calls WHERE source_file_id = ?", [file.file_id]);
      files.updateHash(file.file_id, sha256);
      writeExtraction(file.file_id, path, extraction);
      graph.replaceForFile(file.file_id, path, extraction.imports);
      writeCalls(file.file_id, path, extraction);
    });
    return true;
  }

  function deleteFile(path) {
    const file = files.findByPath(path);
    if (!file) return false;

    database.run("UPDATE imports_exports SET is_broken = 1 WHERE related_file_id = ?", [file.file_id]);
    graph.markTargetBroken(file.file_id);
    return files.remove(file.file_id);
  }

  function renameFile(oldPath, newPath) {
    if (!oldPath) return false;
    const file = files.findByPath(oldPath);
    return file ? files.rename(file.file_id, newPath) : false;
  }

  function withTransaction(operation) {
    if (typeof database.transaction === "function") return database.transaction(operation);
    database.run("BEGIN");
    try { const result = operation(); database.run("COMMIT"); return result; } catch (error) { database.run("ROLLBACK"); throw error; }
  }

  async function extract(path) {
    const absolutePath = resolve(projectRoot, path);
    try {
      return registry.extract(absolutePath, await readFile(absolutePath, "utf8"));
    } catch (error) {
      logger.warning?.("Index extraction failed; retaining the prior index entry.", { path, error: error.message });
      return null;
    }
  }

  function hash(path) {
    return getContentHash(resolve(projectRoot, path));
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

function createRecordId(prefix) {
  return `${prefix}-${randomUUID()}`;
}
