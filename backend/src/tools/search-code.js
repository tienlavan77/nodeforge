// Summary: Exposes scoped, metadata-only queries to Forge Code Search.

import { ConfigurationError } from "../shared/errors.js";
import { assertExecutionScope, checkRetrievalBudget, recordRetrieval } from "./retrieval-governance.js";
import { discoveryCount, discoveryNotice, recordSearch } from "./exploration-state.js";
import { isCoderBlockedPath } from "./tool-authorization.js";

const MAX_QUERY_LENGTH = 200;
const MAX_LIMIT = 50;
const SEARCH_KINDS = new Set(["file", "symbol", "content"]);
const IGNORED_PREFIXES = [".git/", ".forge/runtime/", ".next/", ".next.stale-", "agent-tool/"];

export function createSearchCodeTool({ codeSearch, codeCache, projectLogger = () => {} } = {}) {
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
    if (!SEARCH_KINDS.has(kind)) throw scopedError("SEARCH_KIND_INVALID", "Search kind must be file, symbol, or content.");
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw scopedError("SEARCH_LIMIT_INVALID", `Search limit must be an integer between 1 and ${MAX_LIMIT}.`);
    if (requestedPrefixes.some((prefix) => isCoderBlockedPath(prefix, context) || !approvedPrefixes.some((approved) => isPrefixWithin(prefix, approved)))) throw scopedError("SEARCH_SCOPE_FORBIDDEN", "Search scope must be narrowed to Node-approved allowed_prefixes.");
    checkRetrievalBudget(context, query.length + limit * 500, "search_code");
    let searchResult;
    try { searchResult = await codeSearch.search(projection === "minimal" ? { query, kind, limit } : { query, kind, limit, projection }); }
    catch (error) { throw scopedError("SEARCH_BACKEND_ERROR", "Forge Code Search failed.", error); }
    const matches = (Array.isArray(searchResult?.matches) ? searchResult.matches : [])
      .filter((match) => isPathAllowed(match?.node?.path, requestedPrefixes) && !isIgnoredPath(match?.node?.path) && !isCoderBlockedPath(match.node.path, context))
      .map((match) => toMetadata(match, kind, projection, requestedPrefixes)).slice(0, limit);
    if (codeCache && matches.length) {
      let cached;
      try { cached = await codeCache.prewarm(matches.map((match) => match.path)); }
      catch (error) {
        projectLogger({ event_name: "search_code.prewarm_failed", level: "error", status: "failed", message: "Code cache prewarm failed; search metadata remains available.", task_id: taskId, source: "search-code-tool", error_code: error.code ?? "CACHE_PREWARM_FAILED", payload: { match_count: matches.length } });
        cached = new Map();
      }
      for (const match of matches) {
        const file = cached.get(match.path);
        if (!file) {
          hideUnverifiedIndex(match, "unavailable");
          continue;
        }
        match.indexed_sha256 = file.indexed_sha256;
        match.content_sha256 = file.content_sha256;
        match.index_status = file.index_status;
        if (file.index_status !== "fresh") hideUnverifiedIndex(match, file.index_status);
      }
    }
    recordSearch(context, { query, topPaths: matches.slice(0, 5).map((match) => match.path) });
    const discovery = discoveryCount(context);
    const result = { task_id: taskId, query, kind, index_version: searchResult?.index_version ?? null, matches, discovery_budget: discoveryNotice(context) };
    if (!discovery.edit_started && discovery.remaining <= 2) result.deadline_warning = `${discovery.used} discovery calls used. Discovery is refused after ${discovery.limit}; your next calls must be edit_diff or write_diff.`;
    // Mechanical feedback for empty results: content searches AND-join every
    // term, so a phrased or guessed query returns nothing. The hint steers the
    // agent back to observed identifiers without relying on prompt discipline.
    if (!matches.length) result.hint = "0 matches: all query terms are AND-joined. Search only identifiers or strings you saw in a previous tool result; for exploring an unfamiliar file use kind:\"file\" with projection:\"summary\" to get its symbol map, then read targeted windows.";
    recordRetrieval(context, { bytes: Buffer.byteLength(JSON.stringify(result), "utf8"), tool: "search_code", kind, taskId, resource: query });
    return result;
  }
}

// Hides index-derived source locations until live content has been verified.
function hideUnverifiedIndex(match, status) {
  match.index_status = status;
  delete match.symbols; delete match.graph; delete match.snippet;
  delete match.start_line; delete match.end_line;
}

function toMetadata(match, expectedKind, projection = "minimal", allowedPrefixes = []) {
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
    if (projection === "graph") {
      const graph = node.graph ?? {};
      const allowed = (path) => isPathAllowed(path, allowedPrefixes) && !isIgnoredPath(path);
      metadata.graph = {
        imports: (graph.imports ?? []).filter((link) => allowed(link.path)),
        imported_by: (graph.imported_by ?? []).filter((link) => allowed(link.path)),
        calls: (graph.calls ?? []).filter((call) => allowed(call.caller?.path) && allowed(call.target?.path)),
        index_version: graph.index_version ?? null
      };
    }
  } else if (expectedKind === "content") {
    metadata.language = node.language ?? null;
    metadata.sha256 = node.sha256 ?? null;
    metadata.size_bytes = Number.isInteger(node.size_bytes) ? node.size_bytes : null;
    if (typeof node.snippet === "string" && node.snippet) metadata.snippet = node.snippet;
    if (typeof node.symbol_name === "string" && node.symbol_name) {
      metadata.symbol_name = node.symbol_name;
      metadata.symbol_kind = node.symbol_kind ?? "unknown";
      metadata.start_line = Number.isInteger(node.start_line) ? node.start_line : null;
      metadata.end_line = Number.isInteger(node.end_line) ? node.end_line : null;
    }
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
