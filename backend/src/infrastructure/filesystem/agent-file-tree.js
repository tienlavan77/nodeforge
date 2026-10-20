// Lists only the requested project subtree so agent discovery cannot scan the whole runtime before returning.
import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isDependencyPath } from "./dependency-read.js";

// Stops traversal at the requested depth or result budget, checking cancellation between directory entries.
export async function listAgentFileTree({ projectRoot, path = ".", maxDepth, limit, signal, assertReadPath }) {
  signal?.throwIfAborted();
  if (path !== ".") await assertReadPath(path);
  const entries = [];
  await scan(path === "." ? "" : path, 1);
  const truncated = entries.length > limit;
  return { root: path, entries: entries.slice(0, limit).sort((a, b) => a.path.localeCompare(b.path)), total: entries.length, truncated, ...(truncated ? { total_is_lower_bound: true } : {}) };

  // Checks role access before descending, excluding symlinks and unrelated private directories.
  async function scan(prefix, depth) {
    signal?.throwIfAborted();
    let directory;
    try { directory = await opendir(join(projectRoot, prefix)); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for await (const entry of directory) {
      signal?.throwIfAborted();
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() && !isDependencyPath(relativePath) || !entry.isSymbolicLink() && !entry.isDirectory() && !entry.isFile()) continue;
      try { await assertReadPath(relativePath); }
      catch (error) { if (["FILE_ROLE_FORBIDDEN", "ENOENT"].includes(error.code)) continue; throw error; }
      const directoryEntry = entry.isSymbolicLink() ? (await stat(join(projectRoot, relativePath))).isDirectory() : entry.isDirectory();
      entries.push({ path: relativePath, type: directoryEntry ? "directory" : "file" });
      if (entries.length > limit) return;
      if (directoryEntry && depth < maxDepth && (!isDependencyPath(relativePath) || isDependencyPath(path))) await scan(relativePath, depth + 1);
      if (entries.length > limit) return;
    }
  }
}
