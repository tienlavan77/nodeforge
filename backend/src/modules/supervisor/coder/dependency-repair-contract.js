// Validates explicit Sprint dependency execution requests without interpreting agent prose.
// The approved upstream graph prevents cross-project work, circular waits and silent scope expansion.
import { createHash } from "node:crypto";
import { blockerValidationError } from "../blocker/blocker-validation.js";
import { sameExecutionPlan } from "../../projects/ticket-execution-identity.js";

// Checks the shared five-field request shape before either SDK or persisted replay can schedule work.
export function validateDependencyRequest(value, job) {
  if (value.dependency_request === undefined && value.action !== "dependency_requested") return;
  const request = value.dependency_request;
  // Defines text function behavior for dependency-repair-contract.js.
  const text = (entry) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 8000;
  // Defines list function behavior for dependency-repair-contract.js.
  const list = (entries) => Array.isArray(entries) && entries.length > 0 && entries.length <= 16 && entries.every(text);
  if (job?.stage !== "sprint_leader" || value.action !== "dependency_requested" || !request
    || Object.keys(request).some((key) => !["ticket_id", "reason", "instructions", "expected_results", "evidence_refs"].includes(key))
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(request.ticket_id ?? "")
    || request.ticket_id === job.request?.task_id || !text(request.reason) || !text(request.instructions)
    || !list(request.expected_results) || !list(request.evidence_refs)) {
    throw blockerValidationError("/dependency_request", "dependency_request_invalid", "SL must return dependency_requested with ticket_id, reason, instructions, expected_results and evidence_refs for another approved upstream ticket.");
  }
}

// Resolves actual approved ticket definitions and retains the current execution basis for restart fencing.
export async function inspectDependencyRequest(job, value, { sprintRegistry, ticketStatusStore }) {
  validateDependencyRequest(value, job);
  const basis = job.request.payload.sprint_basis;
  const { sprint, plan } = await sprintRegistry.assertReady(job.request.ticket.sprint_id, { expectedVersion: basis.version });
  if (!sameExecutionPlan(sprint, basis)) throw dependencyRepairError("Approved Sprint changed before dependency scheduling.");
  const specs = plan.content.ticket_specs ?? [];
  const source = specs.find((ticket) => ticket.id === job.request.task_id);
  const target = specs.find((ticket) => ticket.id === value.dependency_request.ticket_id);
  const seen = new Set();
  const visiting = new Set();
  // Follows only declared upstream links; a cyclic approved graph must never become an execution loop.
  function visit(ticket) {
    if (!ticket || visiting.has(ticket.id)) throw dependencyRepairError("Approved dependency graph is incomplete or cyclic.");
    if (seen.has(ticket.id)) return;
    visiting.add(ticket.id);
    for (const id of ticket.dependencies ?? []) { visit(specs.find((entry) => entry.id === id)); }
    visiting.delete(ticket.id); seen.add(ticket.id);
  }
  visit(source);
  if (!target || !seen.has(target.id) || target.id === source.id || target.project_id !== job.request.project_id
    || target.sprint_id !== source.sprint_id) throw blockerValidationError("/dependency_request/ticket_id", "dependency_target_invalid", "Repair target must be an approved upstream ticket in the same project Sprint.");
  const current = ticketStatusStore.get(target.id);
  if (!current || current.project_id !== job.request.project_id || !sameExecutionPlan(current.details.execution_basis, basis) || current.details.execution_basis.version !== basis.version
    || !current.details.execution_id)
    throw dependencyRepairError("Dependency has no execution bound to the approved Sprint.");
  return { ticket: target, basis, execution_id: current.details.execution_id };
}

// Gives repeated delivery the same durable identity without depending on timestamps or free-text summaries.
export function dependencyRepairId(job, request) {
  return createHash("sha256").update(JSON.stringify([job.request.project_id, job.request.payload.execution_id, job.id, request])).digest("hex");
}

// Reports an operational dependency boundary to SL instead of manufacturing an Owner approval requirement.
export function dependencyRepairError(message, code = "DEPENDENCY_REPAIR_CONFLICT") {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

// Rechecks the parent intent when an occupied Coder is finally free, so Stop also cancels deferred dependency dispatch.
export async function assertDependencyRepairDispatch(binding, { ticketId, ticketStatusStore, queueStore, disposition }) {
  if (!binding) return;
  const parent = ticketStatusStore.get(binding.parent_ticket_id);
  const target = ticketStatusStore.get(ticketId);
  const ledgers = await queueStore.withLock("blocker.recovery", () => queueStore.list("blocker.recovery"));
  const live = ledgers.some((ledger) => ledger.task_id === binding.parent_ticket_id && ledger.execution_id === binding.parent_execution_id
    && ledger.project_id === binding.project_id && !ledger.cancelled && ledger.jobs.some((job) =>
      job.id === binding.job_id && job.status === "dependency_wait" && job.dependency_request_id === binding.id));
  if (!live || parent?.project_id !== binding.project_id || parent.details.execution_id !== binding.parent_execution_id
    || !["pending", "running", "needs_human_review"].includes(parent.status) || parent.details.reason === "TICKET_STOPPED"
    || (await disposition?.get(binding.parent_ticket_id))?.disposition === "cancelled" || target?.details.dependency_repair?.id !== binding.id)
    throw dependencyRepairError("Dependency repair requester was stopped or replaced; deferred RUN cancelled.", "DEPENDENCY_REPAIR_CANCELLED");
}
