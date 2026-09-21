import { ConfigurationError } from "../../shared/errors.js";
import { createFileNode, createSymbolNode } from "./code-graph-contract.js";
import { tokenizeSearchText } from "./search-vocabulary.js";

/** Minimal lexical search over indexed paths, metadata, and symbol names. */
export function createCodeSearch({ database } = {}) {
  if (!database || typeof database.all !== "function") throw new ConfigurationError("Code Search requires an index database.");
  return Object.freeze({ search, symbolsForFile });

  function symbolsForFile(path) {
    if (typeof path !== "string" || !path.trim()) throw new ConfigurationError("Code Search symbolsForFile requires a path.");
    return database.all("SELECT s.name, s.kind, s.start_line, s.end_line FROM symbols s JOIN files f ON f.file_id = s.file_id WHERE f.path = ? ORDER BY s.start_line, s.name", [path]).map((row) => ({ name: row.name, kind: row.kind, start_line: row.start_line, end_line: row.end_line }));
  }

  function search({ query, kind = "all", limit = 20, projection = "minimal" } = {}) {
    if (typeof query !== "string" || !query.trim()) throw new ConfigurationError("Code Search query is required.");
    if (!["all", "file", "symbol", "content"].includes(kind)) throw new ConfigurationError(`Unsupported Code Search kind: ${kind}.`);
    if (!["minimal", "summary", "graph"].includes(projection)) throw new ConfigurationError(`Unsupported Code Search projection: ${projection}.`);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ConfigurationError("Code Search limit must be an integer between 1 and 100.");
    const terms = tokenizeSearchText(query);
    const version = indexVersion();
    const matches = [];
    if (kind === "content") return Object.freeze({ query: query.trim(), matches: Object.freeze(contentMatches(query, limit, version, projection).filter((match) => !isTestPath(match.node?.path))), index_version: version });
    if (kind !== "symbol") {
      for (const row of database.all("SELECT file_id, path, language, sha256, size_bytes FROM files ORDER BY path")) {
        if (isTestPath(row.path)) continue;
        const score = scoreFile(row, terms);
        if (score > 0) matches.push({ type: "file", score, reason: reasonsFile(row, terms), node: projectFileNode(createFileNode({ fileId: row.file_id, path: row.path, language: row.language, sha256: row.sha256, sizeBytes: row.size_bytes, indexVersion: version }), projection, version), index_version: version });
      }
    }
    if (kind !== "file") {
      for (const row of database.all("SELECT s.symbol_id, s.file_id, s.name, s.kind, s.start_line, s.end_line, f.path, f.language, f.sha256 FROM symbols s JOIN files f ON f.file_id = s.file_id ORDER BY f.path, s.start_line")) {
        if (isTestPath(row.path)) continue;
        const score = scoreSymbol(row, terms);
        if (score > 0) matches.push({ type: "symbol", score, reason: reasonsSymbol(row, terms), node: projectSymbolNode(createSymbolNode({ symbolId: row.symbol_id, fileId: row.file_id, path: row.path, name: row.name, symbolKind: row.kind, startLine: row.start_line, endLine: row.end_line, indexVersion: version }), row, projection), index_version: version });
      }
    }
    matches.sort((left, right) => right.score - left.score || left.node.path.localeCompare(right.node.path));
    return Object.freeze({ query: query.trim(), matches: Object.freeze(matches.slice(0, limit)), index_version: version });
  }

  function contentMatches(query, limit, version, projection = "minimal") {
    const expression = ftsQuery(query);
    if (!expression) return [];
    // bm25 weights favor path and language hits over raw content; symbol-block
    // matches rank above whole-file matches because they return a bounded range.
    const rows = database.all("SELECT file_id, path, language, content, snippet(file_content_fts, 3, '»', '«', '…', 40) AS snippet, bm25(file_content_fts, 8.0, 1.0, 0.5) AS rank FROM file_content_fts WHERE file_content_fts MATCH ? ORDER BY rank LIMIT ?", [expression, limit]);
    const fileNodes = new Map(rows.map((row) => [row.file_id, { ...projectFileNode(createFileNode({ fileId: row.file_id, path: row.path, language: row.language, indexVersion: version }), projection, version), snippet: row.snippet }]));
    const symbolRows = database.all("SELECT symbol_id, file_id, path, name, kind, content, start_line, end_line, snippet(symbol_content_fts, 5, '»', '«', '…', 40) AS snippet, bm25(symbol_content_fts, 6.0, 6.0, 1.5, 0.5, 0.0, 0.0) AS rank FROM symbol_content_fts WHERE symbol_content_fts MATCH ? ORDER BY rank LIMIT ?", [expression, limit]);
    const symbolMatches = symbolRows.filter((row) => !isTestPath(row.path)).map((row) => ({ type: "content", score: 1 / (1 + Math.max(0, Number(row.rank) || 0)) + 0.5, reason: [`symbol_content_match:${query.trim()}`], node: { ...projectFileNode(createFileNode({ fileId: row.file_id, path: row.path, language: symbolLanguage(row.path), indexVersion: version }), "minimal", version), snippet: row.snippet, symbol_name: row.name, symbol_kind: row.kind, start_line: row.start_line, end_line: row.end_line }, index_version: version }));
    const fileMatches = rows.filter((row) => !isTestPath(row.path)).map((row) => ({ type: "content", score: 1 / (1 + Math.max(0, Number(row.rank) || 0)), reason: [`content_match:${query.trim()}`], node: fileNodes.get(row.file_id), index_version: version }));
    return [...symbolMatches, ...fileMatches].slice(0, limit);
  }

  function projectFileNode(node, mode, version) {
    if (mode === "minimal") return node;
    const symbols = database.all("SELECT name, kind, start_line, end_line FROM symbols WHERE file_id = ? ORDER BY start_line, name", [node.id]).map((row) => ({ name: row.name, kind: row.kind, start_line: row.start_line, end_line: row.end_line }));
    const projected = { ...node, symbols };
    if (mode === "graph") projected.graph = fileGraph(node.id, version);
    return projected;
  }

  function projectSymbolNode(node, row, mode) {
    if (mode === "minimal") return node;
    const file = database.all("SELECT language, sha256, size_bytes FROM files WHERE file_id = ?", [row.file_id])[0] ?? {};
    return { ...node, language: file.language ?? null, sha256: file.sha256 ?? null, size_bytes: Number.isInteger(file.size_bytes) ? file.size_bytes : null };
  }

  function fileGraph(fileId, version) {
    const links = database.all("SELECT related_file_id, kind, is_broken FROM imports_exports WHERE file_id = ?", [fileId]).map((row) => ({ file_id: row.related_file_id, kind: row.kind, broken: Boolean(row.is_broken) }));
    const importedBy = database.all("SELECT file_id, kind, is_broken FROM imports_exports WHERE related_file_id = ?", [fileId]).map((row) => ({ file_id: row.file_id, kind: row.kind, broken: Boolean(row.is_broken) }));
    const calls = database.all("SELECT caller_symbol_id, target_symbol_id, line FROM calls WHERE source_file_id = ?", [fileId]).map((row) => ({ caller_symbol_id: row.caller_symbol_id, target_symbol_id: row.target_symbol_id, line: row.line }));
    return { imports: links, imported_by: importedBy, calls, index_version: version };
  }

  function scoreFile(row, terms) { return terms.reduce((score, term) => score + (row.path.toLowerCase() === term ? 1 : row.path.toLowerCase().includes(term) ? 0.6 : (row.language ?? "").toLowerCase() === term ? 0.35 : 0), 0); }
  function scoreSymbol(row, terms) { return terms.reduce((score, term) => score + (row.name.toLowerCase() === term ? 1 : row.name.toLowerCase().includes(term) ? 0.7 : row.kind.toLowerCase() === term ? 0.25 : row.path.toLowerCase().includes(term) ? 0.2 : 0), 0); }
  function reasonsFile(row, terms) { return terms.flatMap((term) => row.path.toLowerCase() === term ? [`path_exact:${term}`] : row.path.toLowerCase().includes(term) ? [`path_match:${term}`] : (row.language ?? "").toLowerCase() === term ? [`language_match:${term}`] : []); }
  function reasonsSymbol(row, terms) { return terms.flatMap((term) => row.name.toLowerCase() === term ? [`symbol_exact:${term}`] : row.name.toLowerCase().includes(term) ? [`symbol_match:${term}`] : row.kind.toLowerCase() === term ? [`kind_match:${term}`] : row.path.toLowerCase().includes(term) ? [`path_match:${term}`] : []); }
  function ftsQuery(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    const terms = tokenizeSearchText(value);
    if (terms.length <= 1) return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join("");
    // Detect adjacent 2-word phrases: CONVERSATION_BLOCK, conversation-block, or CONVERSATION BLOCK
    // Keep as "conversation block" phrase instead of separate OR terms for precision.
    // Reconstruct phrases from raw by checking _ or - or space adjacency.
    const rawLower = raw.normalize("NFC").toLocaleLowerCase("vi-VN");
    const phraseTokens = [];
    const rawTokens = rawLower.split(/[\s_]+/).filter(Boolean);
    // Not needed here; just use normal OR for long queries. Phrase only when raw explicitly has 2 adjacent meaningful tokens.
    // Keep simple: OR-join keeps phrased queries from zeroing out; bm25 ranking still favors
    // matches containing more terms, so precision comes from ordering not AND.
    return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  }
  function isTestPath(path) {
    return typeof path === "string" && (/(^|\/)tests?(\/|$)/.test(path) || path.includes(".test.") || path.includes("__tests__"));
  }
  function symbolLanguage(path) { const extension = path.slice(path.lastIndexOf(".")).toLowerCase(); return { ".js": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".php": "php", ".css": "css" }[extension] ?? null; }
  function indexVersion() { return `IDX-${database.all("SELECT version FROM index_metadata LIMIT 1")[0]?.version ?? 0}`; }
}
