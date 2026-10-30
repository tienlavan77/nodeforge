// Launches bounded Coder repairs with durable handoff, dependency authority, and fresh finding-aware SDK checkpoints.
import { currentReviewFindings } from "../review/review-query-records.js";
import { assertDependencySubmission } from "./ticket-dependency-expectations.js";
import { prepareTicketExecutionContext } from "./ticket-execution-context.js";
import { setAutomaticReviewStage } from "../review/automatic-review-stage.js";
import { reviewRepairRecovery } from "../review/review-repair-handoff.js";
import { prepareRepairExchange } from "../review/review-agent-exchange.js";

// Builds a repair runner that retains the same ticket scope and records launch ownership before another provider turn.
export function createTicketReviewRepair({ workspace, taskId, ownerId, ticket, selected, checkpoints, handoffQueue, ticketStatusStore, sprintRegistry, abortSignal, execute, projectLogger }) {
  return async ({ request: previous, findings, outcome }) => {
    const exchange = await workspace.reviewFindings?.loadQuery?.();
    const references = currentReviewFindings(findings, exchange);
    const request = { ...previous, attempt: (previous.attempt ?? 1) + 1, request_id: `${previous.request_id}-REPAIR-${previous.attempt ?? 1}`,
      payload: { ...previous.payload, review_findings: references, review_resume: null } };
    // Defines validate function behavior for ticket-review-repair.js.
    const validate = () => assertDependencySubmission({ projectId: request.project_id, ticket, payload: request.payload, sprintRegistry, ticketStatusStore });
    validate();
    if (abortSignal?.aborted) throw abortSignal.reason;
    setAutomaticReviewStage({ task_id: taskId, project_id: previous.project_id, source_request: previous,
      payload: previous.payload, review_policy: { gate: "on" } }, ticketStatusStore, "running");
    const retained = await checkpoints?.load?.(taskId);
    const resume = outcome.payload.repair_implementation_required && retained
      ? { ...retained, status: "in_progress", review_findings: references,
        blocker_recovery: reviewRepairRecovery(retained.blocker_recovery, outcome.payload.job_key), attempt: request.attempt }
      : { task_id: taskId, status: "in_progress", agent_id: selected.agent_id, provider: selected.provider,
      contract_decisions: retained?.contract_decisions ?? [], blocker_recovery: reviewRepairRecovery(retained?.blocker_recovery, outcome.payload.job_key), changed_paths: previous.execution_context?.manifest_paths ?? [],
      review_findings: references, attempt: request.attempt, session_id: null, thread_id: null, last_completed_turn: 0, completed_tools: [], turn_history: [], read_cache: {}, coder_rules_read: false };
    if (outcome.payload.repair_implementation_required) resume.repair_implementation_required = outcome.payload.repair_implementation_required;
    request.payload.resume_from = resume;
    if (workspace.beginFindingRepair && !outcome.payload.repair_implementation_required) {
      resume.phase = "finding_repair_preparing";
      resume.review_repair_key = outcome.payload.job_key;
      resume.changed_paths = [];
      await checkpoints?.save?.(resume);
      await workspace.beginFindingRepair(outcome.payload.job_key);
      resume.phase = "finding_repair_ready";
      delete request.payload.retry_source_identity;
    }
    request.execution_context = await prepareTicketExecutionContext({ workspace, taskId, supervisorId: ownerId, ticket });
    const communication = await prepareRepairExchange({ request, selected, reviewerId: outcome.payload.reviewer_id, findings: references,
      projectRoot: workspace.projectRoot ?? workspace.path, reviewRef: outcome.payload.communication?.response_ref, projectLogger });
    if (communication) { request.payload.agent_exchange = communication; resume.agent_exchange = communication; }
    const job = await handoffQueue.enqueue(request);
    let launch;
    try {
      validate();
      if (request.payload.dependency_expectations !== undefined) launch = ticketStatusStore.claimExecutionLaunch(taskId, { executionId: request.payload.execution_id, basis: request.payload.sprint_basis,
        requestId: request.request_id, jobId: job.id, supervisorId: ownerId, agentId: selected.agent_id, claimId: request.claim_id, validate });
      await checkpoints?.saveReview?.({ task_id: taskId, status: "completed", verdict: "request_changes", findings: outcome.payload.findings, review_findings: references, attempt: previous.attempt });
      await checkpoints?.save?.(resume);
      const result = await execute({ ...request, abortSignal });
      if (abortSignal?.aborted) throw abortSignal.reason;
      validate();
      await handoffQueue.ack?.(job.id);
      if (launch) ticketStatusStore.reconcileExecutionLaunch(taskId, { executionId: request.payload.execution_id, requestId: request.request_id, jobId: job.id, disposition: "executor_returned" });
      await checkpoints?.complete?.(taskId, { phase: "coder_reported", agent_id: selected.agent_id, provider: selected.provider, attempt: request.attempt });
      return { request, result };
    } catch (error) {
      if (request.payload.dependency_expectations !== undefined) await handoffQueue.quarantine(job.id, { requestId: request.request_id, reason: error.code ?? "repair_failed" });
      if (launch && error.code !== "PROVIDER_UNKNOWN" && !error.launch_claim_conflict) ticketStatusStore.reconcileExecutionLaunch(taskId, { executionId: request.payload.execution_id, requestId: request.request_id, jobId: job.id, disposition: "executor_failed" });
      if (error.code === "CODER_BLOCKED") error.failed_request = request;
      throw error;
    }
  };
}
