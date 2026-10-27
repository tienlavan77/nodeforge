// Provides automatic cascading empty-parent directory cleanup after file deletion or move operations while preserving root boundaries.
import { readdir, rmdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const PROTECTED_STOP_DIRS = new Set(["", ".", ".git", ".forge"]);

// Removes empty ancestor directories from a mutated file path toward the project root, stopping before root, .git, .forge, or non-empty parents.
export async function pruneEmptyAncestorDirectories({ root, filePath, destinationPath = null, internalBus } = {}) {
  if (typeof root !== "string" || !root || typeof filePath !== "string" || !filePath) return [];
  const resolvedRoot = resolve(root);
  const protectedAncestors = new Set();
  if (typeof destinationPath === "string" && destinationPath) {
    let destDir = dirname( destinationPath.split(sep).join("/") );
    while (destDir && destDir !== "." && !destDir.startsWith("..")) {
      protectedAncestors.add(destDir);
      const next = dirname(destDir);
      if (next === destDir) break;
      destDir = next;
    }
  }
  const removed = [];
  let currentRel = dirname(filePath.split(sep).join("/"));
  while (currentRel && !PROTECTED_STOP_DIRS.has(currentRel) && !currentRel.startsWith("..")) {
    if (protectedAncestors.has(currentRel)) break;
    if (currentRel === ".git" || currentRel.startsWith(".git/")) break;
    const absoluteDir = resolve(resolvedRoot, currentRel);
    const normalizedRel = relative(resolvedRoot, absoluteDir).split(sep).join("/");
    if (!normalizedRel || PROTECTED_STOP_DIRS.has(normalizedRel) || normalizedRel.startsWith("..")) break;
    let entries;
    try {
      entries = await readdir(absoluteDir);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") break;
      throw error;
    }
    if (entries.length > 0) break;
    try {
      await rmdir(absoluteDir);
      removed.push(normalizedRel);
      internalBus?.emit?.("directory.deleted", { path: normalizedRel });
    } catch (error) {
      if (error?.code === "ENOTEMPTY" || error?.code === "ENOENT" || error?.code === "EEXIST" || error?.code === "EBUSY") break;
      throw error;
    }
    const parentRel = dirname(normalizedRel).split(sep).join("/");
    if (parentRel === normalizedRel) break;
    currentRel = parentRel;
  }
  return removed;
}
