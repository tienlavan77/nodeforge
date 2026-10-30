// Serves recorded verification dependencies to Reviewer while keeping committed ticket files and authorship separate.
import { createHash } from "node:crypto";
import { assertRoleFileAccess } from "../../../infrastructure/filesystem/file-service-role-policy.js";
import { loadVerificationEnvironment, readVerificationEnvironmentFile } from "./ticket-verification-environment.js";

// Returns a fixed recorded dependency view for a passed artifact; ticket-owned reads stay committed.
export function createVerificationReviewSource({ projectRoot, source, getArtifact, getTicketPaths }) {
  // Lists the same non-ticket source files that were available to verification, including untracked dependencies.
  async function listFiles() {
    const artifact = await getArtifact();
    if (!artifact?.environment) return source.listFiles();
    const manifest = await loadVerificationEnvironment(projectRoot, artifact.environment);
    const owned = new Set(await getTicketPaths());
    return [...new Set([...Object.keys(artifact.file_checksums ?? {}).filter((path) => owned.has(path) && artifact.file_checksums[path] !== null), ...manifest.map((entry) => entry.path)])].sort();
  }
  // Reads dependency evidence from immutable blobs rather than the current workspace or ticket Git tree.
  async function readForIndex(input) {
    const artifact = await getArtifact();
    if (!artifact?.environment || (await getTicketPaths()).includes(input.path)) return source.readForIndex(input);
    assertRoleFileAccess("reviewer", "read", input.path);
    const manifest = await loadVerificationEnvironment(projectRoot, artifact.environment);
    const entry = manifest.find((file) => file.path === input.path);
    if (!entry) throw Object.assign(new Error("File is absent from the recorded verification environment."), { code: "ENOENT" });
    const bytes = await readVerificationEnvironmentFile(projectRoot, entry);
    if (bytes.length > Math.min(input.maxBytes ?? 64000, 64000) || bytes.includes(0)) throw Object.assign(new Error("Review source exceeds the text read budget."), { code: "REVIEW_EVIDENCE_TOO_LARGE" });
    return { path: input.path, content: bytes.toString("utf8"), size_bytes: bytes.length, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, source: "verification_environment" };
  }
  // Derives bounded directory discovery from the recorded source manifest.
  async function listDirectories() {
    const directories = new Set();
    for (const path of await listFiles()) { const parts = path.split("/"); for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join("/")); }
    return [...directories].sort();
  }
  return { ...source, readForIndex, readFile: async (input) => (await readForIndex(input)).content, listFiles, listDirectories };
}
