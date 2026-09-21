// Summary: Verifies indexed candidates against live file content before they reach agents.
const NORMALIZE = (value) => String(value ?? "").replace(/^sha256:/, "");

// Compares stored index hashes with fresh disk reads. Pure decision helper:
// fresh means index matches disk, stale means disk changed since indexing,
// missing means the row vanished, unreadable means disk read failed.
export function classifyFreshness(indexed, current, { path } = {}) {
  if (!indexed) return { path, status: "missing" };
  if (!current) return { path, status: "unreadable" };
  const a = NORMALIZE(indexed.sha256);
  const b = NORMALIZE(current.sha256);
  if (a && b && a !== b) return { path, status: "stale", indexedSha: indexed.sha256, currentSha: current.sha256 };
  return { path, status: "fresh" };
}

// Builds an async checker over an index database + file service. Verifies only
// the given paths (callers pass the top-N shortlist, never the whole repo).
export function createIndexFreshnessChecker({ database, fileService } = {}) {
  if (!database || typeof database.all !== "function") return null;
  if (!fileService || typeof fileService.readForIndex !== "function") return null;
  return Object.freeze({ checkPaths });

  async function checkPaths(paths) {
    const results = [];
    for (const path of [...new Set(paths)].filter((p) => typeof p === "string" && p)) {
      results.push(await checkOne(path));
    }
    return results;
  }

  async function checkOne(path) {
    const indexed = database.all("SELECT path, sha256, size_bytes, indexed_at FROM files WHERE path = ?", [path])[0] ?? null;
    if (!indexed) return { path, status: "missing" };
    try {
      const current = await fileService.readForIndex({ path });
      return classifyFreshness(indexed, current, { path });
    } catch (error) {
      if (error?.code === "ENOENT") return { path, status: "missing" };
      return { path, status: "unreadable" };
    }
  }
}
