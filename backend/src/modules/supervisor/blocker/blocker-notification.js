// Publishes durable blocker requests while preserving the original execution and checkpoint.
import { recordTicketStage } from "../ticket/ticket-stage-progress.js";
import { notifyBlockerGovernance } from "./blocker-governance-handoff.js";
import { blockerOwnerRequest } from "./blocker-owner-request.js";

// Shares reconciliation evidence with the owner without granting acceptance or execution permission.
export function createBlockerNotification({ inspect, checkDisposition, prepareGovernance, checkpoints, eventBus, projectLogger, replanFoundation, logger, clock }) {
  // Publishes one durable owner/reconciliation request with the complete agent proposal instead of manual coordination.
  return async function notify(job) {
    const authority = await inspect(job);
    if (!authority) return;
    if (job.resolution?.action === "governance_required") {
      await checkDisposition(job.resolution, job);
      return notifyBlockerGovernance({ job, authority, prepareGovernance, checkpoints, eventBus, projectLogger });
    }
    const ownerRequired = job.stage === "architecture_manager" && job.resolution?.action === "owner_required";
    const status = ownerRequired ? "owner_required" : "reconciliation_required";
    const updatedCheckpoint = (await recordTicketStage({ checkpoints, taskId: job.request.task_id, stage: ownerRequired ? "owner_decision" : job.stage ?? "sprint_leader", status,
      details: { job_id: job.id, outcome_reason: job.outcome_reason ?? null }, logger, clock })) ?? authority.checkpoint;
    const foundationEligible = ownerRequired && job.resolution?.escalation?.boundary === "owner_scope";
    const prepareFoundation = typeof replanFoundation === "function" ? replanFoundation : replanFoundation?.prepare?.bind(replanFoundation);
    const foundation = foundationEligible && prepareFoundation ? await prepareFoundation({ job, plan: authority.plan, architecture: authority.architecture }).catch((error) => ({ status: "failed", error: error.message, code: error.code })) : null;
    const reconciliation = { ...job.technical_reconciliation?.work, ...job.resolution?.reconciliation };
    const retainedWaiting = reconciliation?.waiting_for ?? [];
    const retainedRequest = blockerOwnerRequest({ status, job_id: job.id, waiting_for: retainedWaiting,
      owner_request: reconciliation?.owner_request, guidance: job.resolution?.guidance }, job.request.payload.execution_id);
    const ownerResponse = retainedRequest ? [...(job.owner_inputs ?? []), ...(updatedCheckpoint.blocker_owner_inputs ?? [])].findLast((entry) =>
      entry.request_id === retainedRequest.request_id && entry.job_id === job.id && entry.execution_id === job.request.payload.execution_id) : null;
    const ownerRequest = ownerResponse ? null : retainedRequest;
    const waitingFor = ownerResponse && retainedWaiting.filter((entry) => entry?.owner === "external").length === 1
      ? retainedWaiting.filter((entry) => entry?.owner !== "external") : retainedWaiting;
    const sourceChanged = ["TICKET_SOURCE_CHANGED", "TICKET_SOURCE_DRIFT"].includes(job.outcome_reason);
    const retainedDenial = job.execution_admission && job.execution_admission.status !== "retained_for_audit" && !sourceChanged;
    const currentFailure = job.validation_feedback?.find((entry) => entry.reason === job.outcome_reason)?.message ?? job.last_error;
    const denialReason = job.execution_admission?.receipts?.map((receipt) => `${receipt.event_id}: ${receipt.error?.message ?? "Execution denied"}`.split("\n").slice(0, 2).join(" ")).join("; ");
    const prerequisite = waitingFor.map((item) => typeof item === "string" ? item : `${item.owner}: ${item.question}`).join("; ");
    const proposal = retainedDenial ? { title: "Execution stopped at a retained tool denial",
      options: [{ id: "reconcile_denial", description: `${denialReason || job.last_error || "Inspect the retained tool denial evidence."} Required evidence: ${prerequisite || "Reconcile the original denial through its permitted authorization path or establish a materially safer alternative."} RUN alone does not clear this denial.` }], recommended_option_id: "reconcile_denial" }
      : job.resolution?.proposal ?? { title: "Automatic blocker recovery needs reconciliation",
      options: [{ id: "reconcile", description: `Inspect persisted investigation evidence: ${job.outcome_reason}. ${currentFailure ?? "Do not reset or replay an unknown provider invocation."}` }], recommended_option_id: "reconcile" };
    if (["needs_human_review", "pending"].includes(authority.current.status) && !authority.current.details.launch_claim) await checkpoints.save({ ...updatedCheckpoint, status: "blocked", phase: ownerRequired ? "owner_decision" : "blocker_reconciliation_required", blocker_recovery: {
      job_id: job.id, status, reason: job.outcome_reason, proposal, escalation: ownerRequired ? job.resolution.escalation : null, history: job.history,
      governance_handoff: updatedCheckpoint.blocker_recovery?.governance_handoff ?? null,
      execution_admission: job.execution_admission ?? null, waiting_for: waitingFor,
      owner_request: ownerRequest ? reconciliation?.owner_request ?? null : null, guidance: job.resolution?.guidance ?? null,
      owner_response: ownerResponse ?? null,
      waiting_assignments: job.waiting_assignments ?? [], waiting_work_history: job.waiting_work_history ?? [],
      disposition_attempts: job.disposition_attempts ?? [], validation_feedback: job.validation_feedback ?? [], foundation_replan: foundation, last_error: job.last_error ?? null } });
    const request = job.request;
    await eventBus.publish({ type: `task.blocker.${ownerRequired ? "owner_decision_required" : "reconciliation_required"}`, event_id: `BLOCKER-DECISION-${job.id}`, task_id: request.task_id,
      project_id: request.project_id, supervisor_id: request.supervisor_id, request_id: request.request_id,
      correlation_id: request.correlation_id, attempt: 1, payload: { job_id: job.id, reason: job.outcome_reason, execution_admission: job.execution_admission ?? null, waiting_for: waitingFor, owner_input_request: ownerRequest, proposal,
        execution_id: request.payload.execution_id, execution_basis: request.payload.sprint_basis, foundation_replan: foundation } });
    if (ownerRequest || ownerResponse || ownerRequired) await eventBus.publish({ type: "ticket.updated", event_id: `BLOCKER-QUESTION-${job.id}`, project_id: request.project_id,
      task_id: request.task_id, supervisor_id: request.supervisor_id, request_id: request.request_id, correlation_id: request.correlation_id, attempt: 1,
      payload: { ticket_id: request.task_id, reason: ownerRequired ? "blocker_owner_decision_required" : ownerResponse ? "blocker_owner_input_recorded" : "blocker_owner_input_required" } });
    projectLogger({ event_name: `ticket.blocker_${ownerRequired ? "owner_decision_required" : "reconciliation_required"}`, level: "warn", status: "blocked", task_id: request.task_id,
      message: sourceChanged ? `Source refresh required (${job.outcome_reason}): ${currentFailure ?? "Coder must read current source before editing."} Checkpoint and agent decisions retained; historical denial evidence is separate.`
        : retainedDenial ? `Execution stopped (${job.outcome_reason}): ${denialReason || job.last_error || "Retained tool denial requires reconciliation."} Waiting for: ${prerequisite || "permitted resolution of the original tool denial"}. Checkpoint retained; RUN alone does not clear this denial.`
        : ownerRequired ? "Architecture investigation exceeded its authority and needs a bounded owner decision."
        : ownerRequest ? `External response required (${job.outcome_reason}): ${ownerRequest.question} Open the ticket Owner response panel. Checkpoint retained; this is not plan or tool approval.`
        : `Automatic blocker investigation needs technical reconciliation (${job.outcome_reason}): ${job.last_error ?? "No valid disposition was established."} No new owner policy decision was established.`,
      payload: { job_id: job.id, execution_admission: job.execution_admission ?? null, waiting_for: waitingFor, owner_input_request: ownerRequest, waiting_assignments: job.waiting_assignments ?? [], proposal, reason: job.outcome_reason, foundation_replan: foundation, validation_feedback: job.validation_feedback ?? [] } });
  }

}
