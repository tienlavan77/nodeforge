// Tracks compact read metadata so repeat reads of an unchanged path and
// window are refused with READ_REPEATED instead of burning a turn and a full
// file of tokens. Only metadata (sha, sizes) is kept; file content never
// enters the cache, so it is safe to persist in checkpoints across restarts.
import { ConfigurationError } from "../../shared/errors.js";

// Creates an empty read cache for a fresh run.
export function createReadCache() {
  return {};
}

// Rebuilds a safe read cache from a checkpoint snapshot, dropping file
// content and skipping corrupt entries so checkpoints stay small.
export function sanitizeReadCache(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
  const clean = {};
  for (const [key, entry] of Object.entries(snapshot)) {
    if (typeof key !== "string" || !key || !entry || typeof entry !== "object") continue;
    const path = typeof entry.path === "string" ? entry.path : key.split("#")[0];
    if (!path) continue;
    clean[key] = {
      path,
      ...(typeof entry.sha256 === "string" ? { sha256: entry.sha256 } : {}),
      ...(Number.isInteger(entry.total_lines) ? { total_lines: entry.total_lines } : {}),
      ...(Number.isInteger(entry.size_bytes) ? { size_bytes: entry.size_bytes } : {}),
      ...(Number.isInteger(entry.offset) ? { offset: entry.offset } : {}),
      ...(Number.isInteger(entry.limit) ? { limit: entry.limit } : {})
    };
  }
  return clean;
}

// Compacts a run-state cache for checkpoint persistence.
export function snapshotReadCache(cache) {
  return sanitizeReadCache(cache);
}

// Refuses a read_file that repeats a cached path and window.
export function assertReadNotRepeated(cache, input) {
  const path = typeof input?.path === "string" ? input.path : "";
  if (!path) return;
  const cached = cache?.[readCacheKey(input)];
  if (!cached) return;
  throw Object.assign(new ConfigurationError(`Repeat read refused: ${path} with this window is unchanged since your earlier read (sha ${String(cached.sha256 ?? "").slice(0, 12)}). Reuse the content and sha256 you already have; do not call read_file again for it. If you edited the file since, that read is already invalidated — otherwise move on to edit_diff, write_diff, run_test, commit_changes, or report_done.`), { code: "READ_REPEATED", tool: "read_file" });
}

// Caches a successful read result for repeat-read refusal.
export function rememberRead(cache, input, result) {
  if (!cache || typeof cache !== "object") return cache;
  if (!result || typeof result !== "object" || typeof result.content !== "string") return cache;
  cache[readCacheKey(input)] = result;
  return cache;
}

// Drops cached reads of a path after it is written or edited.
export function forgetRead(cache, input) {
  const path = typeof input?.path === "string" ? input.path : "";
  if (!path || !cache) return cache;
  for (const key of Object.keys(cache)) {
    if (key === path || key.startsWith(`${path}#`)) delete cache[key];
  }
  return cache;
}

// Builds the stable address of a read: path plus window, if any.
function readCacheKey(input) {
  const path = typeof input?.path === "string" ? input.path : "";
  const offset = Number.isInteger(input?.offset) ? input.offset : 0;
  const limit = Number.isInteger(input?.limit) ? input.limit : 0;
  return `${path}#${offset}:${limit}`;
}
