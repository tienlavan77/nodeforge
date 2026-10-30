// Caches immutable review source through CodeCacheService so repeated windows, searches and
// evidence checks reuse verified bytes without consulting a mutable project cache. Each review
// invocation owns a bounded cache bound to its project, commit and verification artifact.
import { createCodeCacheService } from "../../context/code-cache-service.js";
import { assertRoleFileAccess } from "../../../infrastructure/filesystem/file-service-role-policy.js";

/** Gives every Reviewer reader the same immutable content cache while preserving its source
 * provenance and read limits. Authorization is checked before a cache hit can disclose bytes;
 * a different invocation or verification artifact never inherits entries from this cache. */
export function createReviewerCodeCache({ source, projectRoot, artifactId, projectLogger }) {
  const cache = createCodeCacheService({ projectId: `${projectRoot}:review:${source.reviewCommit}:${artifactId ?? "snapshot"}`,
    fileService: { readForIndex: (input) => source.readForIndex({ ...input, maxBytes: 64_000 }) }, logger: projectLogger });
  // Keeps snapshot-only access and the caller's byte limit in force even after the initial miss.
  async function readForIndex({ path, maxBytes = 64_000 }) {
    assertRoleFileAccess("reviewer", "read", path);
    const file = await cache.read({ path });
    if (file.size_bytes > Math.min(maxBytes, 64_000)) throw Object.assign(new Error("Committed source exceeds the read budget."), { code: "REVIEW_EVIDENCE_TOO_LARGE" });
    return { ...file, path };
  }
  return { ...source, readForIndex, readFile: async (input) => (await readForIndex(input)).content };
}
