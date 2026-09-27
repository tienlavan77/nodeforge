// Caches agent-discovered source in the Control API while checking live file and index freshness.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_PREWARM_FILES = 8;

// Creates a project-scoped FIFO cache for source reads and bounded graph metadata.
export function createCodeCacheService({ projectId, fileService, codeSearch, clock = () => Date.now(), maxBytes = DEFAULT_MAX_BYTES, ttlMs = DEFAULT_TTL_MS, logger = () => {} } = {}) {
  if (!projectId || typeof fileService?.readForIndex !== "function") throw new ConfigurationError("Code Cache requires project id and File Service.");
  const entries = new Map();
  let usedBytes = 0;
  let sequence = 0;
  let closed = false;

  // Reads live source on miss and returns index metadata only when its checksum is known.
  async function read({ path, prewarm = false } = {}) {
    if (closed) throw new ConfigurationError("Code Cache is closed.");
    if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new ConfigurationError("Code Cache requires a safe project-relative path.");
    const key = `${projectId}:${path}`;
    let entry = entries.get(key);
    if (entry && clock() >= entry.expiresAt) { invalidate({ path }); entry = null; }
    let status = "hit";
    if (!entry) {
      const file = await fileService.readForIndex({ path, ...(prewarm ? { maxBytes } : {}) });
      if (typeof file?.content !== "string") throw new ConfigurationError("Code Cache received invalid source content.");
      const sizeBytes = Buffer.byteLength(file.content, "utf8");
      const sha256 = normalizeHash(file.sha256) ?? `sha256:${createHash("sha256").update(file.content).digest("hex")}`;
      status = sizeBytes > maxBytes ? "bypass" : "miss";
      const cachedAt = clock();
      entry = { content: file.content, sha256, sizeBytes, language: file.language ?? null, cachedAt, expiresAt: cachedAt + ttlMs, fifoSequence: ++sequence };
      if (status === "miss") {
        while (usedBytes + sizeBytes > maxBytes && entries.size) invalidate({ path: entries.keys().next().value.slice(projectId.length + 1) });
        entries.set(key, entry);
        usedBytes += sizeBytes;
      }
    }
    let index = null;
    try { index = codeSearch?.fileMetadata?.(path) ?? null; }
    catch (error) { logger({ event_name: "code_cache.index_unavailable", level: "error", status: "failed", message: "Code Cache metadata query failed.", task_id: `CACHE-${projectId}`, source: "code-cache-service", error_code: error.code ?? "INDEX_UNAVAILABLE", payload: { path } }); }
    const indexedSha = normalizeHash(index?.sha256);
    const indexStatus = indexedSha ? indexedSha === entry.sha256 ? "fresh" : "stale" : "unavailable";
    log("read", { path, cache_status: status, index_status: indexStatus, size_bytes: entry.sizeBytes });
    return {
      content: entry.content, sha256: entry.sha256, size_bytes: entry.sizeBytes, language: entry.language,
      cache: { status, cached_at: status === "bypass" ? null : new Date(entry.cachedAt).toISOString(), expires_at: status === "bypass" ? null : new Date(entry.expiresAt).toISOString() },
      content_sha256: entry.sha256, indexed_sha256: indexedSha, index_version: index?.index_version ?? null, index_status: indexStatus,
      code_index: index ? { path, language: index.language ?? null, symbols: indexStatus === "fresh" ? index.symbols ?? [] : [] } : {},
      code_graph: indexStatus === "fresh" ? boundedGraph(index?.graph) : {}
    };
  }

  // Loads a bounded search result into cache after Forge has authorized its path.
  async function prewarm(paths = []) {
    const selected = [...new Set(paths)].slice(0, MAX_PREWARM_FILES);
    const results = [];
    for (const path of selected) {
      try { results.push({ status: "fulfilled", value: await read({ path, prewarm: true }) }); }
      catch (reason) { results.push({ status: "rejected", reason }); }
    }
    for (let i = 0; i < results.length; i += 1) if (results[i].status === "rejected") logger({ event_name: "code_cache.prewarm_failed", level: "error", status: "failed", message: "Code Cache could not prewarm an approved file.", task_id: `CACHE-${projectId}`, source: "code-cache-service", error_code: results[i].reason?.code ?? "PREWARM_FAILED", payload: { path: selected[i] } });
    return new Map(results.flatMap((result, index) => result.status === "fulfilled" ? [[selected[index], result.value]] : []));
  }

  // Invalidates stale source after a write or watcher file event.
  function invalidate({ path } = {}) {
    const key = `${projectId}:${path}`;
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    usedBytes -= entry.sizeBytes;
    log("invalidated", { path, size_bytes: entry.sizeBytes });
    return true;
  }

  // Refreshes only an existing entry without extending its original expiry.
  async function refreshChanged({ path, expectedSha256 } = {}) {
    const key = `${projectId}:${path}`;
    const previous = entries.get(key);
    if (!previous) return "not_cached";
    try {
      const file = await fileService.readForIndex({ path });
      const sha256 = normalizeHash(file.sha256) ?? `sha256:${createHash("sha256").update(file.content).digest("hex")}`;
      if (expectedSha256 && normalizeHash(expectedSha256) !== sha256) { invalidate({ path }); return "invalidated"; }
      // Read a second checksum to avoid replacing a cached entry with content
      // that raced a concurrent write while the watcher event was in flight.
      const verification = await fileService.readForIndex({ path });
      const verificationSha = normalizeHash(verification.sha256) ?? `sha256:${createHash("sha256").update(verification.content).digest("hex")}`;
      if (verificationSha !== sha256 || verification.content !== file.content) { invalidate({ path }); return "invalidated"; }
      const sizeBytes = Buffer.byteLength(file.content, "utf8");
      invalidate({ path });
      if (sizeBytes > maxBytes || clock() >= previous.expiresAt) return "invalidated";
      while (usedBytes + sizeBytes > maxBytes && entries.size) invalidate({ path: entries.keys().next().value.slice(projectId.length + 1) });
      const reordered = [...entries.entries(), [key, { content: file.content, sha256, sizeBytes, language: file.language ?? null, cachedAt: previous.cachedAt, expiresAt: previous.expiresAt, fifoSequence: previous.fifoSequence }]]
        .sort((left, right) => left[1].fifoSequence - right[1].fifoSequence);
      entries.clear();
      for (const [itemKey, item] of reordered) entries.set(itemKey, item);
      usedBytes += sizeBytes;
      log("refreshed", { path, size_bytes: sizeBytes });
      return "refreshed";
    } catch (error) { invalidate({ path }); logger({ event_name: "code_cache.refresh_failed", level: "error", status: "failed", message: "Code Cache refresh failed; entry invalidated.", task_id: `CACHE-${projectId}`, source: "code-cache-service", error_code: error.code ?? "REFRESH_FAILED", payload: { path } }); return "invalidated"; }
  }

  // Reports cache occupancy without exposing source content.
  function stats() { return { project_id: projectId, entries: entries.size, bytes: usedBytes, max_bytes: maxBytes }; }
  // Emits cache telemetry without including source or search text.
  function log(action, payload) { logger({ event_name: `code_cache.${action}`, level: "info", status: "success", message: `Code Cache ${action}.`, task_id: `CACHE-${projectId}`, source: "code-cache-service", payload }); }
  // Releases all cached source when the API shuts down.
  function close() { entries.clear(); usedBytes = 0; closed = true; }
  return Object.freeze({ read, prewarm, invalidate, refreshChanged, stats, close });
}

// Normalizes File Service and Code Index checksums for safe freshness comparison.
function normalizeHash(value) { return typeof value === "string" && value ? `sha256:${value.replace(/^sha256:/, "")}` : null; }

// Bounds direct graph relationships sent to an agent without opening related files.
function boundedGraph(graph) {
  if (!graph) return {};
  return { imports: (graph.imports ?? []).filter((entry) => entry.path).slice(0, 20), imported_by: (graph.imported_by ?? []).filter((entry) => entry.path).slice(0, 20), calls: (graph.calls ?? []).slice(0, 20) };
}
