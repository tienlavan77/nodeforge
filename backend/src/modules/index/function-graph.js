import { ConfigurationError } from "../../shared/errors.js";
import { createFunctionUsageResult, createGraphEdge, createGraphQueryResult, createSymbolNode } from "./code-graph-contract.js";

/** Read-only function definition and call-site queries over the Code Index. */
export function createFunctionGraph({ database } = {}) {
  if (!database || typeof database.all !== "function") throw new ConfigurationError("Function Graph requires an index database.");
  return Object.freeze({ getFunctions, getCallers, getCallees });

  function getFunctions(path) {
    const file = requireFile(path);
    const rows = database.all("SELECT symbol_id, file_id, name, kind, start_line, end_line FROM symbols WHERE file_id = ? ORDER BY start_line, name", [file.file_id]);
    return createGraphQueryResult({ nodes: rows.map((row) => symbolNode(row, file)), edges: [], indexVersion: indexVersion(), confidence: "static" });
  }

  function getCallers(path, functionName) {
    const target = requireSymbol(path, functionName);
    const rows = database.all(
      `SELECT calls.call_id, calls.line, source.file_id AS source_file_id, source.path AS source_path,
              source.language AS source_language, source.sha256 AS source_sha256,
              caller.symbol_id AS caller_id, caller.name AS caller_name, caller.kind AS caller_kind,
              caller.start_line AS caller_start_line, caller.end_line AS caller_end_line
       FROM calls
       JOIN files source ON source.file_id = calls.source_file_id
       LEFT JOIN symbols caller ON caller.symbol_id = calls.caller_symbol_id
       WHERE calls.target_symbol_id = ? ORDER BY source.path, calls.line`, [target.symbol_id]
    );
    const calledBy = rows.map((row) => ({ file: row.source_path, function: row.caller_name ?? null, line: row.line, kind: "static_call" }));
    const edges = rows.map((row) => createGraphEdge({ from: callerId(row), to: `${target.file.path}#${target.name}`, kind: "call", line: row.line }));
    return createFunctionUsageResult({ symbol: symbolNode(target, target.file), calledBy, indexVersion: indexVersion(), calls: edges });
  }

  function getCallees(path, functionName) {
    const source = requireSymbol(path, functionName);
    const rows = database.all(
      `SELECT calls.call_id, calls.line, target.symbol_id AS target_id, target.name AS target_name,
              target.kind AS target_kind, target.start_line AS target_start_line, target.end_line AS target_end_line,
              target.file_id AS target_file_id, target_file.path AS target_path, target_file.language AS target_language,
              target_file.sha256 AS target_sha256
       FROM calls
       JOIN symbols target ON target.symbol_id = calls.target_symbol_id
       JOIN files target_file ON target_file.file_id = target.file_id
       WHERE calls.caller_symbol_id = ? ORDER BY calls.line, target_file.path, target.name`, [source.symbol_id]
    );
    const calls = rows.map((row) => ({ file: row.target_path, function: row.target_name, line: row.line, kind: "static_call" }));
    const edges = rows.map((row) => createGraphEdge({ from: `${source.file.path}#${source.name}`, to: `${row.target_path}#${row.target_name}`, kind: "call", line: row.line }));
    return createFunctionUsageResult({ symbol: symbolNode(source, source.file), calls, calledBy: edges, indexVersion: indexVersion() });
  }

  function requireFile(path) {
    if (typeof path !== "string" || !path) throw new ConfigurationError("Function Graph path is required.");
    const file = database.all("SELECT file_id, path, language, sha256, size_bytes FROM files WHERE path = ?", [path])[0];
    if (!file) throw new ConfigurationError(`Indexed file not found: ${path}`);
    return file;
  }

  function requireSymbol(path, name) {
    const file = requireFile(path);
    if (typeof name !== "string" || !name) throw new ConfigurationError("Function Graph function name is required.");
    const symbol = database.all("SELECT symbol_id, file_id, name, kind, start_line, end_line FROM symbols WHERE file_id = ? AND name = ? ORDER BY start_line LIMIT 1", [file.file_id, name])[0];
    if (!symbol) throw new ConfigurationError(`Indexed function not found: ${name} in ${path}`);
    return { ...symbol, file };
  }

  function symbolNode(row, file) { return createSymbolNode({ symbolId: row.symbol_id, fileId: row.file_id, path: file.path, name: row.name, symbolKind: row.kind, startLine: row.start_line, endLine: row.end_line, indexVersion: indexVersion() }); }
  function callerId(row) { return `${row.source_path}#${row.caller_name ?? "<module>"}`; }
  function indexVersion() { return `IDX-${database.all("SELECT version FROM index_metadata LIMIT 1")[0]?.version ?? 0}`; }
}
