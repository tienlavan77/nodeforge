// Keeps Supervisor recovery and cached Reviewer verdicts bound to the original execution and verified source evidence.
import { isDeepStrictEqual } from "node:util";
import { ConfigurationError } from "../../shared/errors.js";
import { matchesTicketExecution } from "../projects/ticket-execution-identity.js";
import { assertTicketReviewEvidence } from "./ticket-review-evidence.js";

// Captures the immutable request evidence that a persisted Reviewer verdict actually evaluated.
export function reviewRequestBasis(job) {
  const payload = job.payload ?? {};
  return JSON.parse(JSON.stringify({ task_id: job.task_id, supervisor_id: job.supervisor_id, project_id: job.project_id ?? payload.ticket?.project_id,
    request_id: job.request_id, correlation_id: job.correlation_id, attempt: job.attempt ?? 1,
    execution_id: job.execution_id ?? payload.execution_id, execution_basis: job.execution_basis ?? payload.execution_basis ?? payload.sprint_basis,
    dependency_expectations: payload.dependency_expectations,
    execution_context: job.execution_context ?? payload.execution_context, verification: payload.verification, verification_artifact_id: payload.verification_artifact_id,
    commit_sha: payload.commit_sha, commit: payload.commit, base_commit: payload.base_commit, changed_paths: payload.changed_paths }));
}

// Refuses stale Registry-owned review side effects without upgrading a legacy job to the latest attempt.
export function assertReviewRequestOwnership(job, ticketStatusStore) {
  const current = ticketStatusStore?.get?.(job.task_id);
  const basis = reviewRequestBasis(job);
  if (!current?.details?.execution_id && !basis.execution_id) return;
  if (!current || basis.project_id !== current.details?.execution_basis?.project_id || !matchesTicketExecution(current, basis.execution_id, basis.execution_basis)) {
    throw recoveryConflict("Review request does not own the current Project Ticket execution.");
  }
}

// Revalidates cached verdict identity before it can write findings, checkpoints, or terminal events.
export function assertCachedReviewResult(job) {
  const result = job.review_result;
  if (!result) return;
  const basis = reviewRequestBasis(job);
  if (result.basis ? !isDeepStrictEqual(result.basis, basis) : Boolean(basis.execution_id || basis.execution_context || basis.verification)) {
    throw recoveryConflict("Cached review verdict has missing or changed execution/source evidence.");
  }
  const valid = result.type === "review.failed" ? Boolean(result.payload?.error)
    : result.type === "review.approved" ? result.payload?.verdict === "approved"
      : result.type === "review.request_changes" && result.payload?.verdict === "request_changes";
  if (!valid || (result.type !== "review.failed" && (!result.payload?.reviewer_id || result.payload.reviewer_id === job.agent_id))) {
    throw recoveryConflict("Cached review verdict is not a valid independent Reviewer outcome.");
  }
}

// Revalidates the committed worktree and verification artifact without invoking a Reviewer or dispatching RUN.
export async function validateRecoveredReviewEvidence(job, resolveTicketWorkspace) {
  if (!resolveTicketWorkspace) return;
  const workspace = await resolveTicketWorkspace(job.task_id);
  const evidence = await assertTicketReviewEvidence({ job, executionContexts: workspace.executionContexts,
    verificationService: workspace.testService, gitService: workspace.gitService, fileService: workspace.worktreeFileService, projectRoot: workspace.path });
  if (job.review_result?.payload?.source_revision !== evidence.context.source_revision) {
    throw recoveryConflict("Cached verdict source revision differs from the verified ticket source.");
  }
}

// Selects only evidence for the recovered Supervisor's original request, never the last job sharing a task ID.
export function matchesRecoveryRequest(job, state) {
  const pending = state.pending_request ?? {};
  return job.task_id === state.task_id && job.supervisor_id === state.supervisor_id
    && (!pending.project_id || (job.project_id ?? job.payload?.ticket?.project_id) === pending.project_id)
    && (!pending.correlation_id || job.correlation_id === pending.correlation_id)
    && (!pending.attempt || (job.attempt ?? 1) === pending.attempt)
    && (!pending.queue_job_id || job.id === pending.queue_job_id);
}

// Repairs REVIEWING only from one completed, identity-matched verdict or persisted successful verification result.
export async function recoverReviewingSupervisor({ state, queueStore, stateStore, loop, controlLock, ticketStatusStore, resolveTicketWorkspace, projectLogger }) {
  const reviewJobs = (await queueStore.list("agent.request")).filter((job) => job.operation === "review" && matchesRecoveryRequest(job, state));
  const jobs = reviewJobs.length ? reviewJobs : (await queueStore.list("verification.request")).filter((job) => matchesRecoveryRequest(job, state));
  const job = jobs.length === 1 ? jobs[0] : null;
  // Leaves incomplete or ambiguous recovery evidence untouched for explicit reconciliation.
  const skip = (reason) => projectLogger({ event_name: "supervisor.recovery_evidence_conflict", level: "warn", status: "blocked",
    message: "Supervisor recovery needs exact completed evidence; no execution was launched.", task_id: state.task_id,
    source: "production-runtime", error_code: "EXECUTION_RECONCILIATION_CONFLICT", payload: { supervisor_id: state.supervisor_id, reason } });
  if (!job || job.status !== "completed") return skip("missing_ambiguous_or_incomplete_job");
  let type; let payload;
  try {
    assertReviewRequestOwnership(job, ticketStatusStore);
    if (reviewJobs.length) {
      if (!job.review_result) return skip("missing_review_result");
      assertCachedReviewResult(job);
      if (job.review_result.type !== "review.failed") await validateRecoveredReviewEvidence(job, resolveTicketWorkspace);
      ({ type, payload } = job.review_result);
    } else {
      const result = job.verification_result;
      if (!result || result.payload?.status !== "passed" || !isDeepStrictEqual(result.basis, reviewRequestBasis(job))) return skip("missing_failed_or_unbound_verification_result");
      if (resolveTicketWorkspace) {
        const workspace = await resolveTicketWorkspace(job.task_id);
        const artifact = await workspace.testService.assertPassedArtifact();
        if (artifact.artifact_id !== result.payload.verification_artifact_id || artifact.commit_sha !== result.payload.commit_sha) return skip("verification_artifact_changed");
      }
      type = "verification.passed"; payload = result.payload;
    }
    await controlLock.run(state.task_id, async () => {
      const fresh = await stateStore.get(state.supervisor_id);
      if (fresh?.state !== "REVIEWING" || !isDeepStrictEqual(fresh.pending_request, state.pending_request)) return skip("supervisor_request_changed");
      assertReviewRequestOwnership(job, ticketStatusStore);
      await loop.onEvent({ type, task_id: state.task_id, supervisor_id: state.supervisor_id, project_id: job.project_id,
        request_id: `RECOVER-${job.request_id}`, correlation_id: job.correlation_id, attempt: job.attempt ?? 1, payload });
    });
  } catch (error) {
    projectLogger({ event_name: "supervisor.recovery_evidence_failed", level: "error", status: "blocked",
      message: "Persisted recovery evidence could not be applied.", task_id: state.task_id, source: "production-runtime",
      error_code: error.code ?? "RECOVERY_EVIDENCE_FAILED", payload: { supervisor_id: state.supervisor_id, request_id: job.request_id, error: error.message } });
    if (error.code !== "EXECUTION_RECONCILIATION_CONFLICT" && !error.code?.startsWith("REVIEW_") && !error.code?.startsWith("VERIFY_")) throw error;
  }
}

// Makes stale recovery evidence a non-retryable reconciliation conflict instead of a new attempt.
function recoveryConflict(message) {
  return Object.assign(new ConfigurationError(message), { code: "EXECUTION_RECONCILIATION_CONFLICT", retryable: false });
}
