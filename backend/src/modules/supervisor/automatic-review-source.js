// Retains committed source for asynchronous review after ticket integration releases mutable file claims.
import { createHash } from "node:crypto";
import { createTicketRootGit } from "./ticket-root-git.js";
import { assertReviewerReadPath } from "./reviewer-forge-tools.js";
import { createReviewWorker } from "./review-worker.js";
import { selectTicketReviewer } from "./ticket-agent-provider-routing.js";

// Builds an independent worker that reads the retained Git commit rather than post-integration source.
export function createAutomaticReviewWorkerResolver({ resolveTicketWorkspace, agentResolver, agentOccupancy, gateways, projectLogger }) {
  return async (job) => {
    const workspace = await resolveTicketWorkspace(job.task_id);
    const soft = job.review_policy.gate === "off";
    const profile = selectTicketReviewer(agentResolver, job.payload.ticket, agentOccupancy?.getByTask?.(job.task_id, "reviewer"));
    if (profile.agent_id === job.agent_id) throw Object.assign(new Error("Reviewer must not be the ticket Coder."), { code: "REVIEWER_NOT_AVAILABLE" });
    const root = workspace.path ?? workspace.projectRoot;
    const retained = soft ? committedReviewFiles(root, job.payload.verification.commit_sha) : null;
    const source = retained ?? workspace.worktreeFileService;
    const worker = createReviewWorker({ agentResolver, ...gateways, projectLogger, projectRoot: root,
      fileService: source, rulesFileService: { readForIndex: async () => ({ content: job.review_rules }) },
      codeCache: { read: async (input) => { const file = await source.readForIndex({ ...input, maxBytes: 64_000 }); return { ...file, content_sha256: file.sha256, cache: { status: "bypass" }, index_status: "unavailable" }; } },
      gitService: soft ? { getHead: async () => job.payload.verification.commit_sha } : workspace.gitService,
      executionContexts: soft ? { load: async () => ({ ...job.payload.execution_context, state: "reviewing" }) } : workspace.executionContexts,
      verificationService: soft ? { assertPassedArtifact: async () => job.payload.verification, assertCleanWorktree: async () => {} } : workspace.testService,
      reviewFindings: soft ? { load: async () => job.finding_snapshot } : workspace.reviewFindings });
    const claim = await agentOccupancy?.claim?.({ agentId: profile.agent_id, taskId: job.task_id, supervisorId: job.supervisor_id, role: "reviewer" });
    if (agentOccupancy && !claim) throw Object.assign(new Error("Independent Reviewer is occupied."), { code: "REVIEWER_NOT_AVAILABLE" });
    return { review: async () => {
      try { return await worker.review({ ...job, reviewer_id: profile.agent_id }); }
      finally { if (claim) await agentOccupancy.release({ claimId: claim.claim_id, taskId: job.task_id, supervisorId: job.supervisor_id, reason: "review_attempt_finished" }); }
    } };
  };
}

// Exposes only immutable text blobs with checksums and bounded byte budgets to read-only review tools.
function committedReviewFiles(projectRoot, commit) {
  const git = createTicketRootGit({ projectRoot });
  return { committedReview: true, readForIndex: async ({ path, maxBytes = 64_000 }) => {
    await assertReviewerReadPath(projectRoot, path);
    const content = await git.fileAt(commit, path);
    if (content === null) throw Object.assign(new Error("File absent from reviewed commit."), { code: "ENOENT" });
    const mode = await git.modeAt(commit, path);
    if (mode !== "100644" && mode !== "100755") throw Object.assign(new Error("Review requires a regular committed file."), { code: "FILE_ROLE_FORBIDDEN" });
    const size = Buffer.byteLength(content);
    if (size > maxBytes) throw Object.assign(new Error("Committed review file exceeds the read budget."), { code: "REVIEW_EVIDENCE_TOO_LARGE" });
    return { path, content, size_bytes: size, sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` };
  }, listFiles: async () => [], listDirectories: async () => [] };
}
