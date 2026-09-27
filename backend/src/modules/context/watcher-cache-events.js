// Applies watcher file changes to the Control API cache after project and path validation.
import { isProtectedPath } from "../../infrastructure/filesystem/protected-path-policy.js";

const CACHE_EVENT_TYPES = new Set(["watcher.file_created", "watcher.file_modified", "watcher.file_deleted", "watcher.file_renamed"]);

// Creates an idempotent handler for the existing watcher event POST route.
export function createWatcherCacheEvents({ projectId, codeCache, logger = () => {} } = {}) {
  const seen = new Set();
  return async (event) => {
    if (!codeCache || event?.project_id !== projectId || !CACHE_EVENT_TYPES.has(event?.type)) return "ignored";
    const path = event.payload?.path;
    const oldPath = event.payload?.old_path;
    const sha = event.payload?.sha256;
    if (typeof event.event_id !== "string" || !event.event_id || !safePath(path)
      || (event.type === "watcher.file_renamed" && !safePath(oldPath))
      || (sha !== undefined && (typeof sha !== "string" || !/^(?:sha256:)?[a-fA-F0-9]{64}$/.test(sha)))) {
      logger({ event_name: "code_cache.watcher_rejected", level: "error", status: "failed", message: "Invalid watcher cache event.", task_id: `CACHE-${projectId}`, source: "watcher-cache-events", error_code: "WATCHER_CACHE_EVENT_INVALID", payload: { event_id: event?.event_id, type: event?.type } });
      return "rejected";
    }
    if (seen.has(event.event_id)) return "duplicate";
    seen.add(event.event_id);
    if (seen.size > 10000) seen.delete(seen.values().next().value);
    let status;
    if (event.type === "watcher.file_deleted") status = codeCache.invalidate({ path }) ? "invalidated" : "not_cached";
    else if (event.type === "watcher.file_renamed") {
      codeCache.invalidate({ path: oldPath });
      status = await codeCache.refreshChanged({ path, expectedSha256: sha });
    } else status = await codeCache.refreshChanged({ path, expectedSha256: sha });
    logger({ event_name: "code_cache.watcher_applied", level: "info", status: "success", message: "Watcher cache event applied.", task_id: `CACHE-${projectId}`, source: "watcher-cache-events", payload: { path, type: event.type, cache_status: status } });
    return status;
  };
}

// Restricts watcher cache mutations to safe, non-secret project paths.
function safePath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0")
    && path.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith("."))
    && !isProtectedPath(path, { operation: "read" });
}
