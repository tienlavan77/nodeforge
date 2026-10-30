// Recognizes already integrated project dependencies without claiming their files for a review repair.
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";
import { createHash } from "node:crypto";

// Proves exact source bytes against a completed same-project integration and its retained terminal context.
export async function findIntegratedTicketSource({ path, sha256, targetSha256 = sha256, baselineCommit = null, taskId, projectId, fileService, executionContexts, rootGit }) {
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? "")) return null;
  targetSha256 = String(targetSha256).replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(targetSha256)) return null;
  const paths = await fileService.listFiles({ glob: statePath("ticket-integrations/*.json") });
  for (const receiptPath of paths) {
    const receipt = JSON.parse(await fileService.readFile({ path: receiptPath }));
    if (receipt.status !== "completed" || !["root-only", "worktree"].includes(receipt.workspace_mode) || receipt.task_id === taskId
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(receipt.task_id ?? "")) continue;
    const context = await executionContexts.load(receipt.task_id);
    const reviewedCommit = receipt.reviewed_commit ?? receipt.commit;
    if (context?.project_id !== projectId || context.task_id !== receipt.task_id || context.state !== "terminal"
      || !reviewedCommit || context.review_commit_sha !== receipt.reviewed_commit
      || receipt.workspace_mode === "root-only" && (receipt.commit !== reviewedCommit || context.verification_artifact_id !== receipt.artifact_id || context.manifest_sha !== receipt.manifest_sha
        || context.source_revision !== receipt.source_revision)) continue;
    if (baselineCommit) {
      try { await rootGit.run(["merge-base", "--is-ancestor", baselineCommit, reviewedCommit]); }
      catch (error) {
        try { await rootGit.run(["merge-base", "--is-ancestor", reviewedCommit, baselineCommit]); }
        // eslint-disable-next-line no-silent-catch -- unrelated integration branches cannot establish inherited source.
        catch { if (error.code !== "TICKET_ROOT_GIT_FAILED") throw error; continue; }
      }
    }
    await rootGit.assertAncestor(receipt.commit ?? reviewedCommit);
    const content = await rootGit.fileAt(receipt.commit ?? reviewedCommit, path);
    if (content !== null && createHash("sha256").update(content).digest("hex") === targetSha256)
      return { task_id: receipt.task_id, commit: receipt.commit ?? reviewedCommit, artifact_id: receipt.artifact_id ?? context.verification_artifact_id };
  }
  return null;
}
