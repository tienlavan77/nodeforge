// Materializes reviewed source from one committed ticket tree and checks its verification identity.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { assertReviewerReadPath } from "./reviewer-forge-tools.js";
import { createTicketRootGit } from "./ticket-root-git.js";

const sha = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Rejects any drift between the persisted context, artifact, and worktree commit.
export async function assertTicketReviewEvidence({ job, executionContexts, verificationService, gitService, fileService, projectRoot }) {
  if (!executionContexts?.load || !verificationService?.assertPassedArtifact || !gitService?.getHead || !fileService?.readForIndex) throw fail("REVIEW_EVIDENCE_UNAVAILABLE", "Ticket review needs context, verification, Git, and committed file services.");
  const context = await executionContexts.load(job.task_id);
  const artifact = await verificationService.assertPassedArtifact();
  if (!context || !["verified", "reviewing"].includes(context.state) || !artifact || context.verification_artifact_id !== artifact.artifact_id || context.review_commit_sha !== artifact.commit_sha || context.source_revision !== artifact.source_revision || context.manifest_sha !== artifact.manifest_sha || context.base_sha !== artifact.base_sha) throw fail("REVIEW_EVIDENCE_MISMATCH", "Ticket review identity differs from verified artifact.");
  if (job.payload?.execution_context && (job.payload.execution_context.source_revision !== context.source_revision || job.payload.execution_context.manifest_sha !== context.manifest_sha)) throw fail("REVIEW_EVIDENCE_MISMATCH", "Queued review context is stale.");
  if (job.payload?.verification?.artifact_id && job.payload.verification.artifact_id !== artifact.artifact_id) throw fail("REVIEW_EVIDENCE_MISMATCH", "Queued review artifact differs from persisted evidence.");
  if (job.payload?.base_commit && job.payload.base_commit !== context.base_sha) throw fail("REVIEW_EVIDENCE_MISMATCH", "Queued review baseline differs from ticket context.");
  if (job.payload?.commit && job.payload.commit !== context.review_commit_sha) throw fail("REVIEW_EVIDENCE_MISMATCH", "Queued review commit differs from ticket context.");
  if (gitService.rootOnly) await createTicketRootGit({ projectRoot }).assertAncestor(context.review_commit_sha);
  else if (await gitService.getHead() !== context.review_commit_sha || (verificationService.assertCleanWorktree ? false : (await gitService.status()).trim())) throw fail("REVIEW_COMMIT_STALE", "Ticket worktree no longer represents the verified commit.");
  await verificationService.assertCleanWorktree?.();
  const paths = [...context.manifest_paths].sort();
  if (JSON.stringify(paths) !== JSON.stringify(Object.keys(artifact.file_checksums).sort())) throw fail("REVIEW_EVIDENCE_MISMATCH", "Verified file manifest differs from ticket context.");
  if (job.payload?.changed_paths && JSON.stringify([...job.payload.changed_paths].sort()) !== JSON.stringify([...artifact.changed_paths].sort())) throw fail("REVIEW_EVIDENCE_MISMATCH", "Queued review delta differs from the verified commit.");
  const files = [];
  let totalBytes = 0;
  for (const path of paths) {
    await assertReviewerReadPath(projectRoot, path);
    let file = null;
    try { file = await fileService.readForIndex({ path, maxBytes: 64_000 }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const checksum = file ? sha(file.content) : null;
    if (checksum !== artifact.file_checksums[path]) throw fail("REVIEW_SOURCE_MISMATCH", `Committed source differs from verification: ${path}.`);
    totalBytes += file?.size_bytes ?? 0;
    if (totalBytes > 200_000) throw fail("REVIEW_EVIDENCE_TOO_LARGE", "Ticket review source exceeds its evidence budget.");
    files.push({ path, sha256: checksum, content: file?.content ?? null, deleted: file === null });
  }
  return { context, artifact, files, paths };
}
