import { ConfigurationError } from "../../shared/errors.js";
import { createFileNode, createSymbolNode } from "./code-graph-contract.js";
import { tokenizeSearchText } from "./search-vocabulary.js";

/** Minimal lexical search over indexed paths, metadata, and symbol names. */
export function createCodeSearch({ database } = {}) {
  if (!database || typeof database.all !== "function") throw new ConfigurationError("Code Search requires an index database.");
  return Object.freeze({ search });

  function search({ query, kind = "all", limit = 20 } = {}) {
    if (typeof query !== "string" || !query.trim()) throw new ConfigurationError("Code Search query is required.");
    if (!["all", "file", "symbol", "content"].includes(kind)) throw new ConfigurationError(`Unsupported Code Search kind: ${kind}.`);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ConfigurationError("Code Search limit must be an integer between 1 and 100.");
    const terms = tokenizeSearchText(query);
    const version = indexVersion();
    const matches = [];
    if (kind === "content") return Object.freeze({ query: query.trim(), matches: Object.freeze(contentMatches(query, limit, version)), index_version: version });
    if (kind !== "symbol") {
      for (const row of database.all("SELECT file_id, path, language, sha256, size_bytes FROM files ORDER BY path")) {
        const score = scoreFile(row, terms);
        if (score > 0) matches.push({ type: "file", score, reason: reasonsFile(row, terms), node: createFileNode({ fileId: row.file_id, path: row.path, language: row.language, sha256: row.sha256, sizeBytes: row.size_bytes, indexVersion: version }), index_version: version });
      }
    }
    if (kind !== "file") {
      for (const row of database.all("SELECT s.symbol_id, s.file_id, s.name, s.kind, s.start_line, s.end_line, f.path, f.language, f.sha256 FROM symbols s JOIN files f ON f.file_id = s.file_id ORDER BY f.path, s.start_line")) {
        const score = scoreSymbol(row, terms);
        if (score > 0) matches.push({ type: "symbol", score, reason: reasonsSymbol(row, terms), node: createSymbolNode({ symbolId: row.symbol_id, fileId: row.file_id, path: row.path, name: row.name, symbolKind: row.kind, startLine: row.start_line, endLine: row.end_line, indexVersion: version }), index_version: version });
      }
    }
    matches.sort((left, right) => right.score - left.score || left.node.path.localeCompare(right.node.path));
    return Object.freeze({ query: query.trim(), matches: Object.freeze(matches.slice(0, limit)), index_version: version });
  }

  function contentMatches(query, limit, version) {
    const expression = ftsQuery(query);
    if (!expression) return [];
    const rows = database.all("SELECT file_id, path, language, content, bm25(file_content_fts) AS rank FROM file_content_fts WHERE file_content_fts MATCH ? ORDER BY rank LIMIT ?", [expression, limit]);
    return rows.map((row) => ({ type: "content", score: 1 / (1 + Math.max(0, Number(row.rank) || 0)), reason: [`content_match:${query.trim()}`], node: createFileNode({ fileId: row.file_id, path: row.path, language: row.language, indexVersion: version }), index_version: version }));
  }

  function scoreFile(row, terms) { return terms.reduce((score, term) => score + (row.path.toLowerCase() === term ? 1 : row.path.toLowerCase().includes(term) ? 0.6 : (row.language ?? "").toLowerCase() === term ? 0.35 : 0), 0); }
  function scoreSymbol(row, terms) { return terms.reduce((score, term) => score + (row.name.toLowerCase() === term ? 1 : row.name.toLowerCase().includes(term) ? 0.7 : row.kind.toLowerCase() === term ? 0.25 : row.path.toLowerCase().includes(term) ? 0.2 : 0), 0); }
  function reasonsFile(row, terms) { return terms.flatMap((term) => row.path.toLowerCase() === term ? [`path_exact:${term}`] : row.path.toLowerCase().includes(term) ? [`path_match:${term}`] : (row.language ?? "").toLowerCase() === term ? [`language_match:${term}`] : []); }
  function reasonsSymbol(row, terms) { return terms.flatMap((term) => row.name.toLowerCase() === term ? [`symbol_exact:${term}`] : row.name.toLowerCase().includes(term) ? [`symbol_match:${term}`] : row.kind.toLowerCase() === term ? [`kind_match:${term}`] : row.path.toLowerCase().includes(term) ? [`path_match:${term}`] : []); }
  function ftsQuery(value) { return tokenizeSearchText(value).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND "); }
  function indexVersion() { return `IDX-${database.all("SELECT version FROM index_metadata LIMIT 1")[0]?.version ?? 0}`; }
}
