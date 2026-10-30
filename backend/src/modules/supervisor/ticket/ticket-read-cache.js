// Tracks compact read metadata so repeat reads of an unchanged path and
// window are refused with READ_REPEATED instead of burning a turn and a full
// file of tokens. Only metadata (sha, sizes) is kept; file content never
// enters the cache, so it is safe to persist in checkpoints across restarts.
import { ConfigurationError } from "../../../shared/errors.js";

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
      ...(Number.isInteger(entry.limit) ? { limit: entry.limit } : {}),
      ...(typeof entry.updated_by === "string" ? { updated_by: entry.updated_by } : {}),
      ...(entry.window_invalidated === true ? { window_invalidated: true } : {})
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
  if (!cached || cached.window_invalidated === true) return;
  throw Object.assign(new ConfigurationError(`Repeat read refused: ${path} with this window is unchanged since your earlier read (sha ${String(cached.sha256 ?? "").slice(0, 12)}). Reuse the content and sha256 you already have; do not call read_file again for it. If you edited the file since, that read is already invalidated — otherwise move on to edit_diff, write_diff, run_check, commit_changes, or report_done.`), { code: "READ_REPEATED", tool: "read_file" });
}

// Caches a successful read result for repeat-read refusal and active checksum digests.
export function rememberRead(cache, input, result) {
  if (!cache || typeof cache !== "object" || !result || typeof result !== "object") return cache;
  const path = typeof (input?.path ?? result.path) === "string" ? (input?.path ?? result.path) : "";
  const hasContent = typeof result.content === "string" || typeof result.stdout === "string";
  const validSha = typeof result.sha256 === "string" && /^sha256:[a-fA-F0-9]{64}$/.test(result.sha256);
  if (!path || (!hasContent && !validSha)) return cache;
  const key = readCacheKey({ ...input, path });
  cache[key] = {
    path,
    ...(validSha ? { sha256: result.sha256 } : typeof result.sha256 === "string" ? { sha256: result.sha256 } : {}),
    ...(Number.isInteger(result.total_lines) ? { total_lines: result.total_lines } : {}),
    ...(Number.isInteger(result.size_bytes) ? { size_bytes: result.size_bytes } : {}),
    ...(Number.isInteger(input?.offset ?? input?.start_line) ? { offset: input.offset ?? input.start_line } : {}),
    ...(Number.isInteger(input?.limit ?? input?.end_line) ? { limit: input.limit ?? input.end_line } : {}),
    ...(!hasContent ? { window_invalidated: true } : {})
  };
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

// Business purpose: records the post-mutation file checksum in the read cache so the Coder can immediately chain subsequent edits or moves without re-reading the file, while still permitting a fresh read if needed.
// Technical description: clears stale window entries for the mutated path(s) and stores a window_invalidated digest entry with the latest sha256 extracted from edit_diff, write_diff, or move_file results.
export function recordMutationChecksum(cache, { tool, input, result } = {}) {
  if (!cache || typeof cache !== "object") return cache;
  if (tool === "delete_file") return forgetRead(cache, { path: input?.path });
  const fromPath = input?.from_path ?? input?.fromPath;
  const toPath = input?.to_path ?? input?.toPath ?? input?.path ?? result?.path;
  if (fromPath) forgetRead(cache, { path: fromPath });
  if (toPath) forgetRead(cache, { path: toPath });
  const textReceipt = result?.content?.find?.((item) => item?.type === "text")?.text ?? "";
  const extractedSha = typeof result?.sha256 === "string" ? result.sha256
    : typeof result?.after_checksum === "string" ? result.after_checksum
      : /\((sha256:[a-fA-F0-9]{64})\)/.exec(textReceipt)?.[1] ?? null;
  if (typeof toPath === "string" && toPath && typeof extractedSha === "string" && /^sha256:[a-fA-F0-9]{64}$/.test(extractedSha)) {
    cache[`${toPath}#0:0`] = { path: toPath, sha256: extractedSha, updated_by: tool ?? "mutation", window_invalidated: true };
  }
  return cache;
}

// Business purpose: builds a deduplicated map of known project file paths to their latest sha256 checksums for continuation, resume, and rollover prompts.
// Technical description: aggregates readCache entries by path, preferring entries with a valid sha256 and recording whether the checksum comes from a read or a mutation.
export function activeFileChecksums(cache) {
  if (!cache || typeof cache !== "object") return {};
  const map = {};
  for (const entry of Object.values(cache)) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || !entry.path || typeof entry.sha256 !== "string" || !entry.sha256) continue;
    map[entry.path] = {
      sha256: entry.sha256,
      ...(Number.isInteger(entry.total_lines) ? { total_lines: entry.total_lines } : {}),
      status: entry.updated_by ? `mutated:${entry.updated_by}` : "read"
    };
  }
  return map;
}

// Builds the stable address of a read: path plus window, if any.
function readCacheKey(input) {
  const path = typeof input?.path === "string" ? input.path : "";
  const offset = Number.isInteger(input?.offset ?? input?.start_line) ? (input.offset ?? input.start_line) : 0;
  const limit = Number.isInteger(input?.limit ?? input?.end_line) ? (input.limit ?? input.end_line) : 0;
  return `${path}#${offset}:${limit}`;
}
