import { ConfigurationError } from "../../shared/errors.js";

// Stable vocabulary shared by graph builders, query services, and callers.
export const GRAPH_NODE_KINDS = Object.freeze(["file", "symbol", "test"]);
export const GRAPH_EDGE_KINDS = Object.freeze([
  "import",
  "export",
  "require",
  "dependency",
  "call",
  "reference",
  "test"
]);

export function createFileNode({ path, fileId = null, language = null, sha256 = null, sizeBytes = null, indexVersion = null } = {}) {
  if (typeof path !== "string" || !path.trim()) throw new ConfigurationError("Code Graph file node requires a path.");
  return Object.freeze({
    kind: "file",
    id: fileId,
    path,
    ...(language ? { language } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(Number.isInteger(sizeBytes) ? { size_bytes: sizeBytes } : {}),
    ...(indexVersion ? { index_version: indexVersion } : {})
  });
}

export function createSymbolNode({ symbolId = null, fileId = null, path, name, symbolKind, startLine = null, endLine = null, indexVersion = null } = {}) {
  if (typeof path !== "string" || !path.trim() || typeof name !== "string" || !name.trim()) throw new ConfigurationError("Code Graph symbol node requires path and name.");
  return Object.freeze({
    kind: "symbol",
    id: symbolId,
    file_id: fileId,
    path,
    name,
    symbol_kind: symbolKind ?? "unknown",
    ...(Number.isInteger(startLine) ? { start_line: startLine } : {}),
    ...(Number.isInteger(endLine) ? { end_line: endLine } : {}),
    ...(indexVersion ? { index_version: indexVersion } : {})
  });
}

export function createGraphEdge({ from, to, kind, line = null, confidence = "static", broken = false } = {}) {
  if (!from || !to || typeof from !== "string" || typeof to !== "string") throw new ConfigurationError("Code Graph edge requires string from and to identifiers.");
  if (!GRAPH_EDGE_KINDS.includes(kind)) throw new ConfigurationError(`Unsupported Code Graph edge kind: ${kind ?? "<missing>"}.`);
  if (!Number.isInteger(line) && line !== null) throw new ConfigurationError("Code Graph edge line must be an integer or null.");
  if (!["static", "inferred", "unknown"].includes(confidence)) throw new ConfigurationError(`Unsupported Code Graph confidence: ${confidence}.`);
  return Object.freeze({ from, to, kind, line, confidence, broken: Boolean(broken) });
}

export function createGraphQueryResult({ nodes = [], edges = [], indexVersion = null, confidence = "static" } = {}) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new ConfigurationError("Code Graph query result nodes and edges must be arrays.");
  if (!["static", "inferred", "mixed", "unknown"].includes(confidence)) throw new ConfigurationError(`Unsupported Code Graph result confidence: ${confidence}.`);
  return Object.freeze({
    nodes: Object.freeze([...nodes]),
    edges: Object.freeze([...edges]),
    ...(indexVersion ? { index_version: indexVersion } : {}),
    confidence
  });
}

export function createFileUsageResult({ file, imports = [], importedBy = [], functions = [], indexVersion = null } = {}) {
  if (!file || file.kind !== "file") throw new ConfigurationError("Code Graph file usage result requires a file node.");
  return Object.freeze({
    file,
    file_links: Object.freeze({ imports: Object.freeze([...imports]), imported_by: Object.freeze([...importedBy]) }),
    functions: Object.freeze([...functions]),
    ...(indexVersion ? { index_version: indexVersion } : {})
  });
}

export function createFunctionUsageResult({ symbol, calledBy = [], calls = [], indexVersion = null } = {}) {
  if (!symbol || symbol.kind !== "symbol") throw new ConfigurationError("Code Graph function usage result requires a symbol node.");
  return Object.freeze({
    function: symbol,
    called_by: Object.freeze([...calledBy]),
    calls: Object.freeze([...calls]),
    ...(indexVersion ? { index_version: indexVersion } : {})
  });
}
