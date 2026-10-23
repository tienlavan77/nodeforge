// Reuses verified source for evidence-only review responses when a fresh repair journal has no writes.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { acquireTicketFileLock } from "./ticket-file-lock.js";
import { withTicketProjectCommitLock } from "./ticket-project-commit-lock.js";
import { loadFindingReviewSource } from "./finding-review-repair-workspace.js";

// Maps ticket identities to their existing private journal locations.
const key = (value) => createHash("sha256").update(value).digest("hex");
// Rejects recovery when evidence or a repair journal has changed.
const failure = () => Object.assign(new Error("Evidence-only review source no longer matches the retained repair."), { code: "REVIEW_REPAIR_SOURCE_CONFLICT" });

// Reports a reusable verified revision to SL without mutating its currently parked execution binding.
export async function inspectFindingReviewSource({ taskId, projectId, fileService, executionContexts, ledger }) {
  const context = await executionContexts.load(taskId);
  if (context?.state !== "coding" || !context.source_repair_cycle_id) return null;
  const receipt = await loadFindingReviewSource({ taskId, projectId, fileService, executionContexts, context });
  const manifest = await ledger.load(taskId);
  if (Object.keys(manifest.entries).length || manifest.pending_commit || Object.keys(manifest.commits).length
    || manifest.revision !== receipt.manifest.revision + 1 || manifest.source_repair_cycle_id !== receipt.cycle_id) return null;
  return { status: "available_for_unchanged_response", cycle_id: receipt.cycle_id, commit_sha: receipt.context.review_commit_sha,
    artifact_id: receipt.artifact.artifact_id, source_revision: receipt.context.source_revision,
    instruction: "No Coder writes exist in this finding repair. report_done/respond_to_review can reuse the retained verified source after Node validates its receipt and Git checksums. Do not require duplicate source edits or a new commit solely for evidence delivery. Reviewer has complete ticket history through its existing read_file/read_lines tools." };
}

// Restores only a proven prior verification binding, never source bytes, claims, approval or a new commit.
export async function resumeFindingReviewSource({ taskId, projectId, fileService, executionContexts, ledger, rootGit, projectLogger = () => {} }) {
  const initial = await executionContexts.load(taskId);
  if (initial?.state !== "coding" || !initial.source_repair_cycle_id) return false;
  return withTicketProjectCommitLock({ fileService, projectId }, async () => {
    const scope = key(projectId);
    const contextPath = `${statePath()}/ticket-execution-contexts/${scope}/${taskId}.json`;
    const manifestPath = `${statePath()}/ticket-changes/${scope}/tickets/${key(taskId)}.json`;
    const contextLock = await acquireTicketFileLock(fileService, `${contextPath}.lock`);
    try {
      const ledgerLock = await acquireTicketFileLock(fileService, `${statePath()}/ticket-changes/${scope}/locks/${key(`ticket:${taskId}`)}.lock`);
      try {
        const context = await executionContexts.load(taskId);
        if (context?.state !== "coding" || !context.source_repair_cycle_id) return false;
        const receipt = await loadFindingReviewSource({ taskId, projectId, fileService, executionContexts, context });
        const manifest = await ledger.load(taskId);
        const empty = { project_id: projectId, task_id: taskId, state: "active", revision: receipt.manifest.revision + 1,
          entries: {}, commits: {}, pending_commit: null, source_repair_cycle_id: receipt.cycle_id };
        // A crash may have restored the archived journal before its context; both forms are recoverable.
        if (!isDeepStrictEqual(manifest, empty) && !isDeepStrictEqual(manifest, receipt.manifest)) return false;
        const expected = { ...receipt.context, ...executionContexts.manifestIdentity(empty), state: "coding", verification_artifact_id: null,
          review_commit_sha: null, verification_source: null, source_repair_cycle_id: receipt.cycle_id,
          version: receipt.context.version + 1, updated_at: receipt.created_at };
        if (!isDeepStrictEqual(context, expected)) throw failure();
        await rootGit.assertAncestor(receipt.context.review_commit_sha);
        for (const path of receipt.context.manifest_paths) {
          const content = await rootGit.fileAt(receipt.context.review_commit_sha, path);
          const checksum = content === null ? null : `sha256:${createHash("sha256").update(content).digest("hex")}`;
          if (checksum !== receipt.artifact.file_checksums[path] || checksum !== receipt.manifest.entries[path]?.latest_sha) throw failure();
        }
        const artifact = JSON.parse(await fileService.readFile({ path: `${statePath()}/ticket-verification/${taskId}/artifacts/${receipt.artifact.artifact_id}.json` }));
        if (!isDeepStrictEqual(artifact, receipt.artifact)) throw failure();
        await fileService.atomicWrite({ path: manifestPath, content: JSON.stringify(receipt.manifest), replace: true });
        await fileService.atomicWrite({ path: contextPath, content: JSON.stringify({ ...receipt.context, resumed_finding_cycle_id: receipt.cycle_id,
          version: context.version + 1, updated_at: new Date().toISOString() }), replace: true });
        projectLogger({ event_name: "ticket.review_source_resumed", level: "info", status: "success", task_id: taskId,
          source: "finding-review-source-resume", message: "Unchanged finding repair resumed its prior verified source; no new commit required.",
          payload: { cycle_id: receipt.cycle_id, commit_sha: artifact.commit_sha, artifact_id: artifact.artifact_id } });
        return true;
      } finally { await ledgerLock.release(); }
    } finally { await contextLock.release(); }
  });
}
