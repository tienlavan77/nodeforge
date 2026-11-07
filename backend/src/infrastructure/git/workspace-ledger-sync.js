// Business purpose: Synchronizes working-tree file mutations caused by Node-mediated commands or Git operations into the active ticket/owner change ledger and sha256 checksum store.
// Technical description: Snapshots regular files, symbolic links, and large files across projectRoot (skipping only .git and heavy dependency caches unless requested), computes pre/post file deltas, and updates changeLedger, context.changed_paths, and conversationStateStore while surfacing filesystem and ledger write errors.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, readlink, lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const DEFAULT_SKIPPED_DIRS = new Set([".git", "node_modules"]);
const INLINE_CONTENT_LIMIT_BYTES = 16 * 1024 * 1024;

// Business purpose: Computes a streaming sha256 digest and line count for files larger than INLINE_CONTENT_LIMIT_BYTES without loading the entire file into memory at once.
// Technical description: Reads chunks via createReadStream, updates a sha256 hash and newline counter, and resolves { sha256, totalLines }.
function hashLargeFile(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    let lines = 0;
    let sawBytes = false;
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      sawBytes = true;
      hash.update(chunk);
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] === 0x0a) lines += 1;
      }
    });
    stream.on("error", rejectPromise);
    stream.on("end", () => {
      resolvePromise({
        sha256: `sha256:${hash.digest("hex")}`,
        totalLines: sawBytes ? Math.max(1, lines) : 0
      });
    });
  });
}

// Business purpose: Captures a complete snapshot of files and symbolic links in the project working tree so Node can detect any created, modified, deleted, or restored path.
// Technical description: Recursively walks projectRoot, hashes regular files (buffered up to 16 MiB or streamed above 16 MiB) and symbolic link targets, and throws on unexpected filesystem read errors unless a file vanishes mid-walk (ENOENT).
export async function snapshotWorkingTree(projectRoot, { includeContent = false, skippedDirs = DEFAULT_SKIPPED_DIRS } = {}) {
  const files = new Map();
  if (typeof projectRoot !== "string" || !projectRoot) return files;

  // Business purpose: Traverses project subdirectories and records metadata for regular files and symlinks.
  // Technical description: Reads directory entries, skips only configured skippedDirs (default .git and node_modules), and records sha256, size_bytes, total_lines, and optional UTF-8 content.
  async function walk(currentDir) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (skippedDirs.has(entry.name)) continue;
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(projectRoot, fullPath).split(sep).join("/");
      if (!relPath || relPath.startsWith("..")) continue;
      let stats;
      try {
        stats = await lstat(fullPath);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (stats.isSymbolicLink()) {
        const linkTarget = await readlink(fullPath);
        const sha256 = `sha256:${createHash("sha256").update(`symlink:${linkTarget}`, "utf8").digest("hex")}`;
        files.set(relPath, {
          sha256,
          size_bytes: Buffer.byteLength(linkTarget, "utf8"),
          total_lines: 1,
          content: includeContent ? linkTarget : null,
          is_symlink: true
        });
      } else if (stats.isDirectory()) {
        await walk(fullPath);
      } else if (stats.isFile()) {
        if (stats.size <= INLINE_CONTENT_LIMIT_BYTES) {
          const buffer = await readFile(fullPath);
          const sha256 = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
          const text = includeContent ? buffer.toString("utf8") : null;
          const totalLines = countBufferLines(buffer);
          files.set(relPath, { sha256, size_bytes: stats.size, total_lines: totalLines, content: text });
        } else {
          const { sha256, totalLines } = await hashLargeFile(fullPath);
          files.set(relPath, { sha256, size_bytes: stats.size, total_lines: totalLines, content: null, oversized: true });
        }
      }
    }
  }

  await walk(projectRoot);
  return files;
}

// Business purpose: Counts physical lines in a file buffer so active_file_checksums retains accurate line metadata for subsequent agent reads and edits.
// Technical description: Counts newline bytes (0x0a) in the buffer and returns at least 1 line for non-empty buffers or 0 for empty buffers.
function countBufferLines(buffer) {
  if (!buffer || buffer.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a && i < buffer.length - 1) lines += 1;
  }
  return lines;
}

// Business purpose: Computes the exact file delta between pre-execution and post-execution working-tree snapshots and reconciles the active session/ticket ledger and sha256 checksums.
// Technical description: Compares beforeSnapshot and afterSnapshot, writes created/modified/deleted paths into changeLedger (logging and rethrowing ledger errors), updates context.changed_paths and conversationStateStore, and returns { changed_paths, delta_paths, deleted_paths, active_file_checksums, detailed_checksums }.
export async function reconcileWorkingTreeMutation({
  projectRoot,
  beforeSnapshot,
  afterSnapshot,
  candidatePaths = [],
  context = {},
  changeLedger,
  conversationStateStore,
  conversationId,
  logger,
  toolName = "run_command"
} = {}) {
  const after = afterSnapshot ?? await snapshotWorkingTree(projectRoot, { includeContent: Boolean(changeLedger) });
  const before = beforeSnapshot ?? new Map();
  const touched = [];
  const deleted = [];
  const checksumMap = {};
  const detailedChecksums = {};

  for (const [path, meta] of after.entries()) {
    const prev = before.get(path);
    if (!prev || prev.sha256 !== meta.sha256) {
      touched.push(path);
      checksumMap[path] = meta.sha256;
      detailedChecksums[path] = { sha256: meta.sha256, total_lines: meta.total_lines, status: `mutated:${toolName}` };
      if (changeLedger && typeof changeLedger.write === "function") {
        try {
          const afterContent = meta.content ?? (meta.is_symlink ? await readlink(join(projectRoot, path)) : meta.oversized ? `[oversized:${meta.sha256}]` : await readFile(join(projectRoot, path), "utf8"));
          await changeLedger.write({
            taskId: context?.task_id ?? context?.taskId,
            path,
            before: prev?.content ?? null,
            after: afterContent
          });
        } catch (error) {
          logger?.emit?.({
            event_name: `forge.${toolName}_reconcile_failed`,
            level: "error",
            status: "failed",
            message: `Failed to record mutated path '${path}' in changeLedger: ${error.message}`,
            task_id: context?.task_id ?? context?.taskId ?? "RECONCILE",
            source: "workspace-ledger-sync",
            payload: { path, tool: toolName, error: error.message }
          });
          throw error;
        }
      }
    }
  }

  for (const [path, prev] of before.entries()) {
    if (!after.has(path)) {
      deleted.push(path);
      touched.push(path);
      if (changeLedger && typeof changeLedger.write === "function") {
        try {
          await changeLedger.write({
            taskId: context?.task_id ?? context?.taskId,
            path,
            before: prev?.content ?? "",
            after: null
          });
        } catch (error) {
          logger?.emit?.({
            event_name: `forge.${toolName}_reconcile_failed`,
            level: "error",
            status: "failed",
            message: `Failed to record deleted path '${path}' in changeLedger: ${error.message}`,
            task_id: context?.task_id ?? context?.taskId ?? "RECONCILE",
            source: "workspace-ledger-sync",
            payload: { path, tool: toolName, error: error.message }
          });
          throw error;
        }
      }
    }
  }

  for (const rawPath of candidatePaths) {
    if (typeof rawPath !== "string" || !rawPath) continue;
    const normalized = rawPath.replace(/^\.\//, "").replace(/\/$/, "");
    if (!normalized || normalized.startsWith("..") || normalized.startsWith("/")) continue;
    const entry = after.get(normalized);
    if (entry && !checksumMap[normalized]) {
      checksumMap[normalized] = entry.sha256;
      detailedChecksums[normalized] = { sha256: entry.sha256, total_lines: entry.total_lines, status: `mutated:${toolName}` };
    }
  }

  const mergedChangedPaths = [...new Set([...(context?.changed_paths ?? []), ...touched])].sort();
  if (context && typeof context === "object") {
    context.changed_paths = mergedChangedPaths;
    if (Array.isArray(context.observed_files)) {
      for (const delPath of deleted) {
        const delIdx = context.observed_files.findIndex((item) => item?.path === delPath);
        if (delIdx >= 0) context.observed_files.splice(delIdx, 1);
      }
      for (const [path, sha256] of Object.entries(checksumMap)) {
        const idx = context.observed_files.findIndex((item) => item?.path === path);
        if (idx >= 0) context.observed_files[idx] = { ...context.observed_files[idx], sha256 };
        else context.observed_files.push({ path, sha256, source_tool: toolName });
      }
    }
  }

  const resolvedConvId = conversationId ?? context?.conversation_id ?? context?.task_id;
  if (conversationStateStore?.get && conversationStateStore?.update && typeof resolvedConvId === "string" && resolvedConvId) {
    const currentState = (await conversationStateStore.get(resolvedConvId)) ?? {};
    const nextChecksums = { ...(currentState.active_file_checksums ?? {}) };
    for (const delPath of deleted) delete nextChecksums[delPath];
    for (const [path, info] of Object.entries(detailedChecksums)) nextChecksums[path] = info;
    const nextOwnerPaths = [...new Set([...(currentState.owner_changed_paths ?? []), ...touched])].sort();
    await conversationStateStore.update(resolvedConvId, {
      ...(touched.length ? { owner_changed_paths: nextOwnerPaths, owner_last_commit_sha: null } : {}),
      active_file_checksums: nextChecksums
    });
  }

  return {
    changed_paths: mergedChangedPaths,
    delta_paths: touched.sort(),
    deleted_paths: deleted.sort(),
    active_file_checksums: checksumMap,
    detailed_checksums: detailedChecksums
  };
}
