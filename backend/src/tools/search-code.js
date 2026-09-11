// Summary: Exposes scoped, metadata-only queries to Forge Code Search.

import { ConfigurationError } from "../shared/errors.js";
import { assertExecutionScope, checkRetrievalBudget, recordRetrieval } from "./retrieval-governance.js";

const MAX_QUERY_LENGTH = 200;
const MAX_LIMIT = 50;
const SEARCH_KINDS = new Set(["file", "symbol"]);
const IGNORED_PREFIXES = [".git/", ".forge/runtime/", ".next/", ".next.stale-", "agent-tool/"];

export function createSearchCodeTool({ codeSearch } = {}) {
  if (typeof codeSearch?.search !== "function") throw new ConfigurationError("Search Code tool requires Forge Code Search.");
  return Object.freeze({ name: "search_code", execute });

  async function execute(input = {}, context = {}) {
    const taskId = context.task_id ?? context.taskId;
    const capabilities = new Set(context.capabilities ?? []);
    if (!capabilities.has("search_code")) throw scopedError("TOOL_FORBIDDEN", "Agent is not authorized to use search_code.");
    if (typeof taskId !== "string" || !taskId) throw scopedError("TOOL_SCOPE_INVALID", "Search tool requires the current task_id.");
    assertExecutionScope(context, taskId);
    const kind = input.kind;
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const limit = input.limit;
    const projection = input.projection ?? "minimal";
    const requestedPrefixes = validatePrefixes(input.allowed_prefixes);
    const approvedPrefixes = validateApprovedPrefixes(context.allowed_prefixes ?? context.allowedPrefixes);
    if (!query || query.length > MAX_QUERY_LENGTH) throw scopedError("SEARCH_QUERY_INVALID", `Search query must be between 1 and ${MAX_QUERY_LENGTH} characters.`);
    if (!["minimal", "summary", "graph"].includes(projection)) throw scopedError("SEARCH_PROJECTION_INVALID", "Search projection must be minimal, summary, or graph.");
    if (!SEARCH_KINDS.has(kind)) throw scopedError("SEARCH_KIND_INVALID", "Search kind must be file or symbol.");
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw scopedError("SEARCH_LIMIT_INVALID", `Search limit must be an integer between 1 and ${MAX_LIMIT}.`);
    if (requestedPrefixes.some((prefix) => !approvedPrefixes.some((approved) => isPrefixWithin(prefix, approved)))) throw scopedError("SEARCH_SCOPE_FORBIDDEN", "Search scope must be narrowed to Node-approved allowed_prefixes.");
    checkRetrievalBudget(context, query.length + limit * 500, "search_code");
    let searchResult;
    try { searchResult = await codeSearch.search(projection === "minimal" ? { query, kind, limit } : { query, kind, limit, projection }); }
    catch (error) { throw scopedError("SEARCH_BACKEND_ERROR", "Forge Code Search failed.", error); }
    const matches = (Array.isArray(searchResult?.matches) ? searchResult.matches : [])
      .filter((match) => isPathAllowed(match?.node?.path, requestedPrefixes) && !isIgnoredPath(match?.node?.path))
      .map((match) => toMetadata(match, kind, projection)).slice(0, limit);
    const result = { task_id: taskId, query, kind, index_version: searchResult?.index_version ?? null, matches };
    recordRetrieval(context, { bytes: Buffer.byteLength(JSON.stringify(result), "utf8"), tool: "search_code", kind, taskId, resource: query });
    return result;
  }
}

function toMetadata(match, expectedKind, projection = "minimal") {
  const node = match?.node ?? {};
  const metadata = { kind: expectedKind, path: node.path, score: Number(match?.score) || 0, reason: Array.isArray(match?.reason) ? [...match.reason] : [] };
  if (expectedKind === "file") {
    metadata.language = node.language ?? null;
    if (typeof node.snippet === "string" && node.snippet) metadata.snippet = node.snippet;
    metadata.sha256 = node.sha256 ?? null;
    metadata.size_bytes = Number.isInteger(node.size_bytes) ? node.size_bytes : null;
    if (projection !== "minimal") {
      metadata.snippet = typeof node.snippet === "string" ? node.snippet : null;
      metadata.symbols = Array.isArray(node.symbols) ? node.symbols : [];
    }
    if (projection === "graph") metadata.graph = node.graph ?? { imports: [], imported_by: [], calls: [] };
  } else {
    metadata.name = node.name;
    metadata.symbol_kind = node.symbol_kind ?? "unknown";
    metadata.start_line = Number.isInteger(node.start_line) ? node.start_line : null;
    metadata.end_line = Number.isInteger(node.end_line) ? node.end_line : null;
    if (projection !== "minimal") { metadata.language = node.language ?? null; metadata.sha256 = node.sha256 ?? null; metadata.size_bytes = Number.isInteger(node.size_bytes) ? node.size_bytes : null; }
  }
  return metadata;
}

function validatePrefixes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.some((prefix) => !isSafePrefix(prefix)) || new Set(value).size !== value.length) throw scopedError("SEARCH_SCOPE_FORBIDDEN", "allowed_prefixes must be a non-empty list of unique relative prefixes.");
  return value;
}
function validateApprovedPrefixes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.some((prefix) => !isSafePrefix(prefix))) throw scopedError("SEARCH_SCOPE_FORBIDDEN", "Node must provide approved allowed_prefixes for search.");
  return value;
}
function isSafePrefix(prefix) { return typeof prefix === "string" && prefix.length > 0 && !prefix.startsWith("/") && !prefix.includes("\\") && !prefix.split("/").includes("..") && !prefix.includes("\0"); }
function isPrefixWithin(requested, approved) { return requested === approved || (requested.startsWith(approved) && (approved.endsWith("/") || requested[approved.length] === "/")); }
function isPathAllowed(path, prefixes) { return typeof path === "string" && prefixes.some((prefix) => path === prefix || (path.startsWith(prefix) && (prefix.endsWith("/") || path[prefix.length] === "/"))); }
function isIgnoredPath(path) { return typeof path === "string" && IGNORED_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix)); }
function scopedError(code, message, cause) { const error = new ConfigurationError(message, cause ? { cause } : {}); error.code = code; return error; }
