// incremental indexer - provides incremental indexer functionality for NodeForge.
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { createSummaryConversion } from "./purpose-summary-conversion.js";
import { createDependencyGraph } from "./dependency-graph.js";
import { createFileRepository } from "./file-repository.js";
import { createIndexRecordWriter } from "./index-record-writer.js";
import { extractorRegistry } from "./parser/index.js";
import { readContentHash } from "../watcher/debounced-watcher.js";
import { logEvent } from "../../core/project-log-service.js";

// createIncrementalIndexer - handles createIncrementalIndexer operation.
export function createIncrementalIndexer({ database, projectRoot, registry = extractorRegistry, files = createFileRepository(database), graph = createDependencyGraph({ database, files, projectRoot }), fileService, getContentHash = readContentHash, logger = console, projectLogger = logEvent, embeddingJobs = null, embeddingStore = null, embeddingProvider = null, embeddingModel = "text-embedding-3-small" } = {}) {
  const conversion = createSummaryConversion(database);
  const recordWriter = createIndexRecordWriter({ database, graph, embeddingJobs, embeddingStore, embeddingProvider, embeddingModel, logger });
  const { writeExtraction, clearContentIndex, indexContent, writeCalls } = recordWriter;

  return Object.freeze({
    // Keeps the established boolean API while detailed consumers receive committed outcomes.
    async handle(event) {
      const result = await handleDetailed({ ...event, legacy: true });
      if (result.error && result.marker !== "parse_failed") throw result.error;
      return result.committed;
    },
    handleDetailed
  });

  // Reports one event only after its transaction finishes, retaining failure details for
  // operation progress without treating preserved database rows as successful parsing.
  async function handleDetailed(event) {
    const path = event.payload?.path;
    if (!path || !event.type?.startsWith("watcher.file_")) return { path, status: "ignored", committed: false };
    if (!event.legacy && registry.supports && !registry.supports(path) && event.type !== "watcher.file_deleted") {
      return { path, status: "unsupported", committed: false };
    }
    writeLog("index.started", "info", "Index operation started.", event, path);
    try {
      let committed = false;
      if (event.type === "watcher.file_created" || event.type === "watcher.file_modified") committed = await reindexFile(path, event);
      else if (event.type === "watcher.file_deleted") committed = deleteFile(path, event);
      else if (event.type === "watcher.file_renamed") committed = renameFile(event.payload.old_path, path, event);
      const status = event.phase === "resolve" ? "resolved" : committed ? event.type === "watcher.file_deleted" ? "deleted" : "indexed" : "unchanged";
      return { path, status, committed: Boolean(committed) && event.phase !== "resolve",
        version: database.all("SELECT version FROM index_metadata")[0]?.version ?? 0 };
    } catch (error) {
      writeLog("index.failed", "error", error.message, event, path);
      return { path, status: "failed", committed: false, marker: error.code === "parse_failed" || error.code === "read_failed" ? error.code : "write_failed", message: error.message, error };
    }
  }

  // Defines indexNewFile function behavior for incremental-indexer.js.
  async function indexNewFile(path, event) {
    const snapshot = await readSnapshot(path);
    const sha256 = snapshot?.sha256;
    const sizeBytes = snapshot?.size_bytes;
    if (!sha256) throw Object.assign(new Error("File content unavailable."), { code: "read_failed" });
    const extraction = await extract(path, snapshot.content);
    if (!extraction) throw Object.assign(new Error("File extraction failed."), { code: "parse_failed" });
    let fileId;
    withTransaction(() => {
      fileId = files.insert(path, { language: languageForPath(path), sha256, sizeBytes });
      // Created events can be delivered by more than one watcher process.
      // Replace derived rows so replay remains idempotent after the upsert.

      database.run("DELETE FROM imports_exports WHERE file_id = ?", [fileId]);
      database.run("DELETE FROM calls WHERE source_file_id = ?", [fileId]);
      writeExtraction(fileId, path, extraction, snapshot.content);
      clearContentIndex(fileId, true);
      indexContent(fileId, path, snapshot.content);
      graph.replaceForFile(fileId, path, extraction.imports);
      writeCalls(fileId, path, extraction);
      conversion.complete(fileId, sha256);
      database.run("UPDATE index_metadata SET version = version + 1");
    });
    // Per-symbol embeddings are queued inside indexContent (best-effort, serial).
    writeLog("index.completed", "info", "File indexed.", event, path, "success");
    return true;
  }

  // Defines reindexFile function behavior for incremental-indexer.js.
  async function reindexFile(path, event) {
    const file = files.findByPath(path);
    if (!file) return indexNewFile(path, event);

    const snapshot = await readSnapshot(path);
    const sha256 = snapshot?.sha256;
    const sizeBytes = snapshot?.size_bytes;
    if (!sha256) throw Object.assign(new Error("File content unavailable."), { code: "read_failed" });
    if (sha256 === file.sha256 && event.phase !== "resolve" && !event.force && !conversion.needed(file)) return false;
    const extraction = await extract(path, snapshot.content);
    if (!extraction) throw Object.assign(new Error("File extraction failed; prior index retained."), { code: "parse_failed" });
    if (event.phase === "resolve") {
      withTransaction(() => {
        graph.replaceForFile(file.file_id, path, extraction.imports);
        database.run("DELETE FROM calls WHERE source_file_id = ?", [file.file_id]);
        writeCalls(file.file_id, path, extraction);
      });
      return false;
    }
    if (sha256 === file.sha256 && conversion.needed(file)) {
      // Conversion of an unchanged source uses the accepted summary writer while
      // retaining all structural identities and graph rows from that same source.
      withTransaction(() => {
        clearContentIndex(file.file_id, true);
        indexContent(file.file_id, path, snapshot.content);
        conversion.complete(file.file_id, sha256);
        database.run("UPDATE index_metadata SET version = version + 1");
      });
      return true;
    }
    withTransaction(() => {

      database.run("DELETE FROM imports_exports WHERE file_id = ?", [file.file_id]);
      database.run("DELETE FROM calls WHERE source_file_id = ?", [file.file_id]);
      writeExtraction(file.file_id, path, extraction, snapshot.content);
      clearContentIndex(file.file_id, true);
      files.updateHash(file.file_id, sha256, sizeBytes, languageForPath(path));
      indexContent(file.file_id, path, snapshot.content);
      graph.replaceForFile(file.file_id, path, extraction.imports);
      writeCalls(file.file_id, path, extraction);
      conversion.complete(file.file_id, sha256);
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

    let removed;
    withTransaction(() => {
      database.run("UPDATE imports_exports SET is_broken = 1 WHERE related_file_id = ?", [file.file_id]);
      graph.markTargetBroken(file.file_id);
      clearContentIndex(file.file_id);
      removed = files.remove(file.file_id);
      if (removed) database.run("UPDATE index_metadata SET version = version + 1");
    });
    writeLog(removed ? "index.completed" : "index.skipped", "info", removed ? "File removed from index." : "File was not indexed.", event, path, removed ? "success" : "info");
    return removed;
  }

  // Defines renameFile function behavior for incremental-indexer.js.
  function renameFile(oldPath, newPath, event) {
    if (!oldPath) return false;
    const file = files.findByPath(oldPath);
    const renamed = file ? files.rename(file.file_id, newPath) : false;
    if (renamed) database.run("UPDATE index_metadata SET version = version + 1");
    writeLog(renamed ? "index.completed" : "index.skipped", "info", renamed ? "File renamed in index." : "Rename skipped.", event, newPath, renamed ? "success" : "info");
    return renamed;
  }

  // Defines writeLog function behavior for incremental-indexer.js.
  function writeLog(eventName, level, message, event, path, status = level === "error" ? "failed" : "info") {
    try { projectLogger({ timestamp: new Date().toISOString(), event_name: eventName, level, status, message, task_id: event?.task_id ?? event?.payload?.task_id ?? `INDEX-${path}`, ticket_id: event?.ticket_id ?? event?.payload?.ticket_id, conversation_id: event?.conversation_id ?? event?.payload?.conversation_id, source: "incremental-indexer" }); } catch (error) { logger.warning?.("Project log write failed.", { error: error.message, path }); }
  }

  // Defines withTransaction function behavior for incremental-indexer.js.
  function withTransaction(operation) {
    if (typeof database.transaction === "function") return database.transaction(operation);
    database.run("BEGIN");
    try { const result = operation(); database.run("COMMIT"); return result; } catch (error) { database.run("ROLLBACK"); throw error; }
  }

  // Defines extract function behavior for incremental-indexer.js.
  async function extract(path, content) {
    const absolutePath = resolve(projectRoot, path);
    try {
      return await registry.extract(absolutePath, content ?? await readFile(absolutePath, "utf8"));
    } catch (error) {
      logger.warning?.("Index extraction failed; retaining the prior index entry.", { path, error: error.message });
      throw Object.assign(new Error(error.message, { cause: error }), { code: "parse_failed" });
    }
  }

  // Defines readSnapshot function behavior for incremental-indexer.js.
  async function readSnapshot(path) {
    try {
      if (fileService?.readForIndex) return await fileService.readForIndex({ path });
      const absolutePath = resolve(projectRoot, path);
      const content = await readFile(absolutePath, "utf8");
      return { content, sha256: await hash(path), size_bytes: await fileSize(path), language: languageForPath(path) };
    } catch (error) { throw Object.assign(new Error(error.message, { cause: error }), { code: "read_failed" }); }
  }

  // Defines hash function behavior for incremental-indexer.js.
  function hash(path) {
    return getContentHash(resolve(projectRoot, path));
  }

  // Defines fileSize function behavior for incremental-indexer.js.
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
