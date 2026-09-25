// Persists extracted symbols, relationships, searchable content, and embeddings for indexed files.
import { randomUUID } from "node:crypto";
import { extname } from "node:path";

import { checksumEmbeddingText } from "./embedding-job-store.js";

// Creates database writers that preserve file extraction and symbol search records.
export function createIndexRecordWriter({ database, graph, embeddingJobs, embeddingStore, embeddingProvider, embeddingModel, logger }) {
  return Object.freeze({
    writeExtraction,
    clearContentIndex,
    indexContent,
    writeCalls
  });

  // Stores extracted symbols and their import/export relationships.
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

  // Removes full-text and embedding records for a file before reindexing or deletion.
  function clearContentIndex(fileId) {
    database.run("DELETE FROM file_content_fts WHERE file_id = ?", [fileId]);
    database.run("DELETE FROM symbol_content_fts WHERE file_id = ?", [fileId]);
    // eslint-disable-next-line no-silent-catch -- Embedding cleanup is best-effort; index rows are already deleted.
    try { embeddingStore?.removeByFile?.(fileId); } catch { /* embedding cleanup is best-effort */ }
  }

  // Indexes file and symbol text for full-text search and queues symbol embeddings.
  function indexContent(fileId, path, content) {
    if (typeof content !== "string") return;
    database.run("INSERT INTO file_content_fts (file_id, path, language, content) VALUES (?, ?, ?, ?)", [fileId, path, languageForPath(path), content]);
    const lines = content.split(/\r?\n/);
    const rows = database.all("SELECT symbol_id, name, kind, start_line, end_line FROM symbols WHERE file_id = ? ORDER BY start_line, name", [fileId]);
    for (const symbol of rows) {
      const start = Math.max(1, symbol.start_line ?? 1);
      const end = Math.min(lines.length, Math.max(start, symbol.end_line ?? start));
      let extendedStart = start;
      for (let idx = start - 2; idx >= Math.max(0, start - 4); idx -= 1) {
        const trimmed = (lines[idx] ?? "").trim();
        if (/^(?:\/\/|\/\*|\*|#|<!--)/.test(trimmed)) extendedStart = idx + 1;
        else break;
      }
      const symbolContent = lines.slice(extendedStart - 1, end).join("\n");
      database.run("INSERT INTO symbol_content_fts (symbol_id, file_id, path, name, kind, content, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [symbol.symbol_id, fileId, path, symbol.name, symbol.kind, symbolContent, symbol.start_line, symbol.end_line]);
      queueSymbolEmbedding({ symbolId: symbol.symbol_id, name: symbol.name, kind: symbol.kind, path, content: symbolContent });
    }
  }

  // Queues symbol embeddings serially and skips symbols whose content checksum is unchanged.
  function queueSymbolEmbedding({ symbolId, name, kind, path, content }) {
    if (!symbolId) return;
    const checksum = checksumEmbeddingText(`${name}\n${kind}\n${content ?? ""}`);
    if (embeddingJobs?.enqueue) {
      queueMicrotask(() => {
        try { embeddingJobs.enqueue({ symbolId, contentChecksum: checksum, model: embeddingModel }); } catch (error) { logger.debug?.("Embedding job enqueue skipped.", { path, symbol: name, error: error.message }); }
      });
      return;
    }
    if (!embeddingStore || !embeddingProvider) return;
    void (async () => {
      try {
        const checksum = checksumEmbeddingText(`${name}\n${kind}\n${content ?? ""}`);
        const existing = database.all("SELECT content_checksum, embedding_model FROM symbol_embeddings WHERE symbol_id = ?", [symbolId])[0];
        if (existing?.content_checksum === checksum && existing?.embedding_model === embeddingModel) return;
        const vector = await embeddingProvider.embed(`${name} [${kind}]\n${content ?? ""}`.slice(0, 4000));
        embeddingStore.upsert({ symbolId, vector, model: embeddingModel, checksum });
      } catch (error) {
        logger.debug?.("Symbol embedding skipped.", { path, symbol: name, error: error.message });
      }
    })().catch((error) => { logger.error?.("Symbol embedding task failed.", { path, symbol: name, error: error.message }); });
  }

  // Persists one resolved import or export relationship for an indexed file.
  function writeRelation(fileId, path, item, name, kind) {
    const relatedFileId = graph.resolve(path, item.source, item.external);
    const isBroken = Number(!item.external && item.source && !relatedFileId);
    database.run(
      "INSERT INTO imports_exports (relation_id, file_id, related_file_id, name, kind, is_broken) VALUES (?, ?, ?, ?, ?, ?)",
      [createRecordId("REL"), fileId, relatedFileId, name, kind, isBroken]
    );
  }

  // Resolves extracted calls to local or imported symbols and persists the links.
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

  // Resolves a call to a local symbol, imported symbol, or required module symbol.
  function resolveCallTarget(fileId, path, call, imports) {
    const localTarget = findSymbolId(fileId, call.callee_name);
    if (localTarget) return localTarget;

    const imported = imports.find((item) => item.local === call.callee_name);
    if (imported) {
      const targetFileId = graph.resolve(path, imported.source, imported.external);
      return targetFileId ? findSymbolId(targetFileId, imported.imported) : null;
    }

    for (const required of imports.filter((item) => item.kind === "require")) {
      const targetFileId = graph.resolve(path, required.source, required.external);
      const targetSymbolId = targetFileId ? findSymbolId(targetFileId, call.callee_name) : null;
      if (targetSymbolId) return targetSymbolId;
    }
    return null;
  }

  // Looks up a persisted symbol identifier within one indexed file.
  function findSymbolId(fileId, name) {
    if (!name) return null;
    return database.all("SELECT symbol_id FROM symbols WHERE file_id = ? AND name = ? LIMIT 1", [fileId, name])[0]?.symbol_id ?? null;
  }
}

// Maps supported source extensions to their indexed language names.
function languageForPath(path) {
  const extension = extname(path).toLowerCase();
  return { ".js": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".php": "php", ".css": "css" }[extension] ?? null;
}

// Creates unique identifiers for persisted index records.
function createRecordId(prefix) {
  return `${prefix}-${randomUUID()}`;
}
