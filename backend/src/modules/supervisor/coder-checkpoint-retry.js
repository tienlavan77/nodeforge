// Re-arms timed infrastructure recovery from an explicit RUN without replaying completed Coder work.
import { randomUUID } from "node:crypto";
import { approvalServiceUnavailable } from "./blocker-approval-retry.js";
import { assertApprovedTicket } from "../governance/sprint-plan-draft.js";
import { assertDependencyExpectations } from "./ticket-dependency-expectations.js";
import { matchesTicketExecution } from "../projects/ticket-execution-identity.js";

// Schedules only a retained approval-service outage; substantive denials and unknown providers keep their existing gates.
export async function resumeCoderCheckpointRetry({ projectId, ticketId, ticket, recovery, ticketStatusStore, sprintRegistry,
  checkpoints, resolveTicketWorkspace, disposition, projectLogger }) {
  const current = ticketStatusStore.get(ticketId);
  const checkpoint = await checkpoints.load(ticketId);
  if (current?.project_id !== projectId || !["pending", "failed", "needs_human_review", "running"].includes(current.status)
    || current.details.launch_claim || checkpoint?.status !== "blocked" || checkpoint.failure?.code !== "CODER_BLOCKED"
    || !approvalServiceUnavailable({ error: checkpoint.failure }) || checkpoint.blocker_recovery
    || !current.details.execution_id) return null;
  if ((await disposition?.get(ticketId))?.disposition === "cancelled") return null;
  const basis = current.details.execution_basis;
  if (!matchesTicketExecution(current, current.details.execution_id, basis)) return null;
  const { plan } = await sprintRegistry.assertReady(ticket.sprint_id, { expectedVersion: basis.version });
  assertApprovedTicket(plan, ticket);
  const workspace = await resolveTicketWorkspace(ticketId);
  const context = await workspace.executionContexts.load(ticketId);
  if (!context || context.state === "terminal" || context.project_id !== projectId || context.task_id !== ticketId) return null;
  const payload = { execution_id: current.details.execution_id, sprint_basis: basis, dependency_expectations: current.details.dependency_expectations,
    resume_from: { ...checkpoint, status: "in_progress", failure: null },
    ...(current.details.review_reopen?.repair_cycle_id ? { review_cycle_id: current.details.review_reopen.repair_cycle_id } : {}) };
  const validate = () => assertDependencyExpectations({ projectId, ticket, expectations: payload.dependency_expectations, sprintRegistry, ticketStatusStore });
  validate();
  if (current.status !== "running") ticketStatusStore.resumeBlockedExecution(ticketId, { executionId: payload.execution_id, basis, expectedVersion: current.version,
    dependencyExpectations: payload.dependency_expectations, validate });
  const request = { project_id: projectId, task_id: ticketId, ticket, supervisor_id: `SUP-${ticketId}`,
    request_id: `REQ-RESUME-${randomUUID()}`, correlation_id: `CORR-RESUME-${randomUUID()}`, execution_context: context, payload };
  await recovery.resume({ request });
  const result = await recovery.handleFailure({ request, error: { code: "SERVICE_UNAVAILABLE", provider_outcome: "failed", retry_safe: true,
    message: checkpoint.failure.message }, source: "owner_resume_approval_outage" });
  if (!result.handled || !["pending", "terminal_pending"].includes(result.outcome)) throw Object.assign(new Error("Retained outage could not schedule a checkpoint retry."), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
  const retry = { interval_ms: 30_000, available_at: result.record.available_at, original_failure: checkpoint.failure };
  await checkpoints.save({ ...checkpoint, status: result.outcome === "pending" ? "in_progress" : "failed",
    phase: result.outcome === "pending" ? "operational_retry_pending" : "operational_retry_exhausted", operational_retry: retry });
  projectLogger({ event_name: "supervisor.coder_recovery_decision", level: "warn", status: result.outcome, task_id: ticketId,
    message: result.outcome === "pending" ? "Dịch vụ duyệt lỗi 503. Node sẽ retry sau 30 giây từ checkpoint mới nhất; nhấn Stop để tạm dừng." : "Coder operational retry budget exhausted; checkpoint retained.",
    payload: { failure_id: result.record.failure_id, retry_after_ms: 30_000, available_at: retry.available_at, resumed_from_turn: checkpoint.last_completed_turn } });
  return { ticket_id: ticketId, execution_id: payload.execution_id, status: "recovery_pending", pipeline: "supervisor", resumed: true,
    resumed_from_turn: checkpoint.last_completed_turn, retry_after_ms: 30_000 };
}
