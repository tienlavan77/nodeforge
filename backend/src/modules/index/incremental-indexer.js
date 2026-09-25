// incremental indexer - provides incremental indexer functionality for NodeForge.
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { createDependencyGraph } from "./dependency-graph.js";
import { createFileRepository } from "./file-repository.js";
import { createIndexRecordWriter } from "./index-record-writer.js";
import { extractorRegistry } from "./parser/index.js";
import { readContentHash } from "../watcher/debounced-watcher.js";
import { logEvent } from "../../core/project-log-service.js";

// createIncrementalIndexer - handles createIncrementalIndexer operation.
export function createIncrementalIndexer({ database, projectRoot, registry = extractorRegistry, files = createFileRepository(database), graph = createDependencyGraph({ database, files, projectRoot }), fileService, getContentHash = readContentHash, logger = console, projectLogger = logEvent, embeddingJobs = null, embeddingStore = null, embeddingProvider = null, embeddingModel = "text-embedding-3-small" } = {}) {
  const recordWriter = createIndexRecordWriter({ database, graph, embeddingJobs, embeddingStore, embeddingProvider, embeddingModel, logger });
  const { writeExtraction, clearContentIndex, indexContent, writeCalls } = recordWriter;

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
    // Per-symbol embeddings are queued inside indexContent (best-effort, serial).
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
    // Per-symbol embeddings are queued inside indexContent (best-effort, serial).
    writeLog("index.completed", "info", "File index updated.", event, path, "success");
    return true;
  }

  // Per-symbol embedding is queued inside indexContent via queueSymbolEmbedding.
  // (File-level indexEmbedding removed: symbol granularity replaces it.)

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
    // eslint-disable-next-line no-silent-catch -- Stat probe: missing file means unknown size, handled by callers.
    try { return (await stat(resolve(projectRoot, path))).size; } catch { return null; }
  }

}

// Maps supported source extensions to their indexed language names.
function languageForPath(path) {
  const extension = extname(path).toLowerCase();
  return { ".js": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".php": "php", ".css": "css" }[extension] ?? null;
}
