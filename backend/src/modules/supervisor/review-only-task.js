// Reruns independent review against an existing commit while preserving Coder execution ownership.
import { ConfigurationError } from "../../shared/errors.js";
import { matchesTicketExecution } from "../projects/ticket-execution-identity.js";
import { ensureReviewStatusReady } from "./review-only-status.js";
import { resolveReviewOnlyWorkspace } from "./review-only-workspace.js";
import { selectTicketReviewer } from "./ticket-agent-provider-routing.js";

// Reviews retained evidence without dispatching Coder or replacing its execution identity.
export async function runReviewOnly({ ticket, task_id, project_id, request_id, correlation_id, commit, base_commit, changed_paths, evidence = {}, coder_agent_id } = {},
  { reviewer, ticketStatusStore, resolveTicketWorkspace, gitService, fileService, agentResolver, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, codeSearch, checkpoints, projectLogger, agentOccupancy, publishTicketOutcome }) {
    if (!ticket || typeof ticket !== "object") throw new ConfigurationError("Review-only ticket is required.");
    if (!commit || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(commit)) throw new ConfigurationError("Review-only commit is required.");
    if (!reviewer) throw Object.assign(new ConfigurationError("Independent review is unavailable."), { code: "REVIEW_WORKER_UNAVAILABLE" });
    const reviewTaskId = task_id ?? ticket.id;
    const reviewExecution = ticketStatusStore?.get?.(reviewTaskId);
    const reviewPayload = reviewExecution?.details.execution_id ? { execution_id: reviewExecution.details.execution_id, sprint_basis: reviewExecution.details.execution_basis } : {};
    const { workspace, useWorkspace, reviewWorker, reviewBase } = await resolveReviewOnlyWorkspace({ resolveTicketWorkspace, taskId: reviewTaskId, commit, baseCommit: base_commit, reviewer, gitService, fileService, agentResolver, gateways: { claudeSdkGateway, openaiSdkGateway, codexSdkGateway }, codeSearch, checkpoints, projectLogger });
    const paths = [...new Set(changed_paths ?? ["ui/nextjs/README.md"])];
    const reviewOwnerId = `SUP-REVIEW-${reviewTaskId}`;
    const reviewProfile = selectTicketReviewer(agentResolver, ticket);
    const reviewClaim = await agentOccupancy?.claim?.({ agentId: reviewProfile.agent_id, taskId: reviewTaskId, supervisorId: reviewOwnerId, projectId: project_id ?? ticket.project_id, role: "reviewer" });
    if (agentOccupancy && !reviewClaim) throw Object.assign(new ConfigurationError("Reviewer is already working on another ticket."), { code: "REVIEWER_NOT_AVAILABLE" });
    const priorReview = await checkpoints?.loadReview?.(reviewTaskId);
    const nextReviewAttempt = (priorReview?.review_attempt ?? 0) + 1;
    let result;
    try {
      ensureReviewStatusReady(ticketStatusStore, reviewTaskId);
      result = await reviewWorker.review({
        review_only: true, task_id: reviewTaskId, project_id, request_id: request_id ?? `REVIEW-${ticket.id}-${Date.now()}`,
        correlation_id: correlation_id ?? `CORR-REVIEW-${ticket.id}-${Date.now()}`, agent_id: coder_agent_id ?? "review-only-coder", reviewer_id: reviewClaim?.agent_id,
        review_attempt: nextReviewAttempt,
        payload: { ticket, commit, base_commit: reviewBase, changed_paths: paths, verification: evidence }
      });
      if (useWorkspace) { const artifact = await workspace.testService.assertPassedArtifact(); await workspace.reviewFindings.recordReview({ ...result, artifactId: artifact.artifact_id, commitSha: artifact.commit_sha, reviewerId: result.reviewer_id, sourceRevision: artifact.source_revision }); }
      await checkpoints?.completeReview?.(reviewTaskId, {
        phase: "review", review_only: true, reviewer_id: result.reviewer_id, reviewer_name: reviewProfile.agent_name,
        provider: reviewProfile.provider, review_attempt: nextReviewAttempt,
        request_id: request_id ?? `REVIEW-${ticket.id}`, correlation_id: correlation_id ?? `CORR-REVIEW-${ticket.id}`,
        changed_paths: paths, base_commit: reviewBase, commit, verdict: result.verdict, findings: result.findings, adjudications: result.adjudications ?? [], last_error: null
      });
    } finally {
      if (reviewClaim) await agentOccupancy.release({ claimId: reviewClaim.claim_id, taskId: reviewTaskId, supervisorId: reviewOwnerId, reason: "review_only_completed" });
    }
    if (result.verdict === "approved" && useWorkspace) { await workspace.integrate(); await workspace.changeLedger.release(); }
    if (reviewPayload.execution_id && !matchesTicketExecution(ticketStatusStore.get(reviewTaskId), reviewPayload.execution_id, reviewPayload.sprint_basis)) throw Object.assign(new ConfigurationError("Review completion belongs to an obsolete Ticket execution."), { code: "TICKET_EXECUTION_CONFLICT" });
    ensureReviewStatusReady(ticketStatusStore, reviewTaskId);
    const outcomeType = result.verdict === "approved" ? "task.completed" : "task.needs_human_review";
    await publishTicketOutcome(outcomeType, { task_id: task_id ?? ticket.id, project_id: project_id ?? ticket.project_id, payload: reviewPayload, request_id: request_id ?? `REVIEW-${ticket.id}`, correlation_id: correlation_id ?? `CORR-REVIEW-${ticket.id}` }, `SUP-REVIEW-${ticket.id}`, { review_only: true, commit, verdict: result.verdict, findings: result.findings, reviewer_id: result.reviewer_id, evidence });
    return { task_id: task_id ?? ticket.id, commit, verdict: result.verdict, findings: result.findings, reviewer_id: result.reviewer_id, status: result.verdict === "approved" ? "approved" : "needs_human_review" };
}
