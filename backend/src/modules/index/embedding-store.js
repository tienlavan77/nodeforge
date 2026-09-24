// Stores per-file embedding vectors in SQLite and serves cosine search in-process.
// Indexing happens once at Watcher index time (cached by sha256); querying happens
// once per relevant-tree select at Node layer — never inside agent tool loops.
import { ConfigurationError } from "../../shared/errors.js";

// Creates an embedding vector store on top of the code index database.
// Schema lives in index-database.js migration 9 (symbol_embeddings); this module
// only reads/writes, never creates tables.
export function createEmbeddingStore({ database, logger = console } = {}) {
  if (!database || typeof database.all !== "function" || typeof database.run !== "function") throw new ConfigurationError("Embedding store requires an index database.");
  return Object.freeze({ upsert, remove, removeByFile, search });

  function upsert({ symbolId, vector, model, checksum }) {
    if (!symbolId || !Array.isArray(vector) || !vector.length) throw new ConfigurationError("Embedding upsert requires symbolId and vector.");
    if (typeof model !== "string" || !model) throw new ConfigurationError("Embedding upsert requires a model tag.");
    const blob = Buffer.from(Float32Array.from(vector.map(Number)).buffer).toString("base64");
    database.run(
      "INSERT INTO symbol_embeddings (symbol_id, embedding_model, vector, content_checksum, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(symbol_id) DO UPDATE SET embedding_model = excluded.embedding_model, vector = excluded.vector, content_checksum = excluded.content_checksum, updated_at = excluded.updated_at",
      [symbolId, model, blob, checksum ?? null, new Date().toISOString()]
    );
  }

  function remove(symbolId) {
    if (!symbolId) return;
    database.run("DELETE FROM symbol_embeddings WHERE symbol_id = ?", [symbolId]);
  }

  function removeByFile(fileId) {
    if (!fileId) return;
    database.run("DELETE FROM symbol_embeddings WHERE symbol_id IN (SELECT symbol_id FROM symbols WHERE file_id = ?)", [fileId]);
  }

  function search(queryVector, { limit = 8, allowedPrefixes, model } = {}) {
    if (!Array.isArray(queryVector) || !queryVector.length) return [];
    const rows = model
      ? database.all("SELECT e.symbol_id, e.vector, e.content_checksum, f.path FROM symbol_embeddings e JOIN symbols s ON s.symbol_id = e.symbol_id JOIN files f ON f.file_id = s.file_id WHERE e.embedding_model = ?", [model])
      : database.all("SELECT e.symbol_id, e.vector, e.content_checksum, f.path FROM symbol_embeddings e JOIN symbols s ON s.symbol_id = e.symbol_id JOIN files f ON f.file_id = s.file_id");
    const byPath = new Map();
    for (const row of rows) {
      if (allowedPrefixes && !allowedPrefixes.some((prefix) => row.path.startsWith(prefix))) continue;
      const vec = decode(row.vector, logger, row.symbol_id, row.content_checksum);
      if (!vec || vec.length !== queryVector.length) continue;
      const sim = cosine(queryVector, vec);
      if (!Number.isFinite(sim)) continue;
      const current = byPath.get(row.path);
      if (!current || sim > current.score) byPath.set(row.path, { path: row.path, score: sim });
    }
    return [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

function decode(blob, logger = console, symbolId = null, checksum = null) {
  try {
    const buf = Buffer.from(String(blob), "base64");
    return Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
  } catch (error) {
    // eslint-disable-next-line no-silent-catch -- Logging must not affect search; outer catch already returns null.
    try { logger?.warn?.("Embedding vector decode failed.", { symbol_id: symbolId, checksum, error: error.message }); } catch { /* logging must not affect search */ }
    return null;
  }
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
