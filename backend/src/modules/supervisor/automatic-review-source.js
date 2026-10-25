// Retains committed source for asynchronous review after ticket integration releases mutable file claims.
import { createVerificationReviewSource } from "./ticket-verification-review-source.js";
import { createCommittedReviewSource } from "./reviewer-committed-source.js";
import { createReviewWorker } from "./review-worker.js";
import { selectTicketReviewer } from "./ticket-agent-provider-routing.js";

// Builds an independent worker that reads the retained Git commit rather than post-integration source.
export function createAutomaticReviewWorkerResolver({ resolveTicketWorkspace, agentResolver, agentOccupancy, gateways, checkpoints, projectLogger, fileService, eventBus, ticketStatusStore }) {
  return async (job) => {
    const workspace = await resolveTicketWorkspace(job.task_id);
    const soft = job.review_policy.gate === "off";
    const profile = selectTicketReviewer(agentResolver, job.payload.ticket, agentOccupancy?.getByTask?.(job.task_id, "reviewer"));
    if (profile.agent_id === job.agent_id) throw Object.assign(new Error("Reviewer must not be the ticket Coder."), { code: "REVIEWER_NOT_AVAILABLE" });
    const root = workspace.path ?? workspace.projectRoot;
    const retained = soft ? createCommittedReviewSource({ projectRoot: root, commit: job.payload.verification.commit_sha, baseCommit: job.payload.verification.base_sha }) : null;
    const source = retained ? createVerificationReviewSource({ projectRoot: root, source: retained,
      getArtifact: async () => job.payload.verification, getTicketPaths: async () => job.payload.execution_context.manifest_paths }) : workspace.worktreeFileService;
    // Supplies committed bytes for discovery without claiming the current index verifies this revision.
    const read = async (input) => { const file = await source.readForIndex({ ...input, maxBytes: 64_000 }); return { ...file, content_sha256: file.sha256, cache: { status: "bypass" }, index_status: "unavailable" }; };
    const worker = createReviewWorker({ agentResolver, ...gateways, checkpoints, projectLogger, projectRoot: root,
      fileService: source, contractFileService: fileService, codeSearch: workspace.codeSearch, rulesFileService: { readForIndex: async () => ({ content: job.review_rules }) },
      codeCache: { read, prewarm: async (paths) => new Map(await Promise.all(paths.map(async (path) => [path, await read({ path })]))) },
      gitService: soft ? { getHead: async () => job.payload.verification.commit_sha, diffPatchFrom: retained.diffPatchFrom, status: workspace.gitService?.status, diffWorkingTree: workspace.gitService?.diffWorkingTree } : workspace.gitService,
      executionContexts: soft ? { load: async () => ({ ...job.payload.execution_context, state: "reviewing" }) } : workspace.executionContexts,
      verificationService: soft ? { assertPassedArtifact: async () => job.payload.verification, assertCleanWorktree: async () => {}, runReviewVerification: workspace.testService.runReviewVerification } : workspace.testService,
      reviewFindings: soft ? { load: async () => job.finding_snapshot } : workspace.reviewFindings });
    const claim = await agentOccupancy?.claim?.({ agentId: profile.agent_id, taskId: job.task_id, supervisorId: job.supervisor_id, projectId: job.project_id ?? job.payload.ticket.project_id, role: "reviewer" });
    if (agentOccupancy && !claim) throw Object.assign(new Error("Independent Reviewer is occupied."), { code: "REVIEWER_NOT_AVAILABLE" });
    return { review: async () => {
      const controller = new AbortController();
      // Stops source checks and Reviewer continuation on the existing execution Stop event, without a polling loop.
      const assertActive = () => {
        controller.signal.throwIfAborted();
        const current = ticketStatusStore?.get(job.task_id);
        if (current && (current.details?.execution_id !== job.payload.execution_id || current.details?.reason === "TICKET_STOPPED")) throw Object.assign(new Error("Ticket review was stopped or replaced."), { code: "TICKET_STOPPED" });
      };
      const unsubscribe = eventBus?.subscribe(job.supervisor_id, (event) => {
        if (event.task_id === job.task_id && event.payload?.execution_id === job.payload.execution_id && event.payload?.reason === "TICKET_STOPPED") controller.abort(Object.assign(new Error("Ticket stopped by owner."), { code: "TICKET_STOPPED" }));
      });
      try { assertActive(); return await worker.review({ ...job, reviewer_id: profile.agent_id, abortSignal: controller.signal, assertActive }); }
      finally { unsubscribe?.(); if (claim) await agentOccupancy.release({ claimId: claim.claim_id, taskId: job.task_id, supervisorId: job.supervisor_id, reason: "review_attempt_finished" }); }
    } };
  };
}
