// Keeps the original dependency completion intent intact across shared RUN, persisted claims and provider preparation.
import { isDeepStrictEqual } from "node:util";
import { matchesTicketExecution, sameExecutionPlan, validExecutionBasis } from "../projects/ticket-execution-identity.js";

// Returns a serializable immutable plan and scheduling identity without projection-only metadata.
export function executionBasisSnapshot(basis) {
  return Object.fromEntries(["project_id", "sprint_id", "plan_id", "plan_revision", "plan_path", "plan_sha256", "version"].map((field) => [field, basis[field]]));
}

// Reports obsolete or incomplete dependency intent as a scoped reconciliation conflict, never an automatic retry.
function conflict(ticketId) {
  return Object.assign(new Error("Ticket dependency expectations changed or require execution reconciliation."), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409, retryable: false, scope: "scoped", identifiers: typeof ticketId === "string" ? [ticketId] : [] });
}

// Validates the captured dependency set without resolving a newer plan or replacing its original completion attempt.
export function assertDependencyExpectations({ projectId, ticket, expectations, sprintRegistry, ticketStatusStore }) {
  if (expectations === undefined) return; // Explicit compatibility path; entrypoint convergence remains a separate gate.
  if (!Array.isArray(expectations) || !Array.isArray(ticket?.dependencies ?? [])) throw conflict(ticket?.id);
  const ids = (ticket.dependencies ?? []).map((id) => typeof id === "string" ? id : null);
  if (ids.includes(null) || new Set(ids).size !== ids.length || expectations.length !== ids.length || new Set(expectations.map((entry) => entry?.ticket_id)).size !== ids.length) throw conflict(ticket.id);
  for (const expected of expectations) {
    const ticketId = expected?.ticket_id;
    if (!ids.includes(ticketId) || !validExecutionBasis(expected?.sprint_basis) || !validExecutionBasis(expected?.execution_basis) || expected.sprint_basis.project_id !== projectId || !sameExecutionPlan(expected.sprint_basis, expected.execution_basis)) throw conflict(ticketId ?? ticket.id);
    const basis = sprintRegistry?.get?.(expected.sprint_basis.sprint_id);
    const current = ticketStatusStore?.get?.(ticketId);
    if (!sameExecutionPlan(basis, expected.sprint_basis) || basis.version !== expected.sprint_basis.version || !["ready", "running", "done"].includes(basis.status) || current?.status !== "done" || !matchesTicketExecution(current, expected.execution_id, expected.execution_basis)) throw conflict(ticketId);
  }
}

// Captures individual RUN dependencies once so later boundaries cannot silently substitute a newer completion attempt.
export async function captureDependencyExpectations({ projectId, ticket, sprintRegistry, ticketStatusStore }) {
  const expectations = [];
  for (const ticketId of ticket.dependencies ?? []) {
    const basis = await sprintRegistry.getByTicket(ticketId);
    const current = ticketStatusStore.get(ticketId);
    if (!validExecutionBasis(basis) || basis.project_id !== projectId || current?.status !== "done" || !matchesTicketExecution(current, current.details?.execution_id, current.details?.execution_basis) || !sameExecutionPlan(basis, current.details.execution_basis)) throw conflict(ticketId);
    expectations.push({ ticket_id: ticketId, execution_id: current.details.execution_id, execution_basis: executionBasisSnapshot(current.details.execution_basis), sprint_basis: executionBasisSnapshot(basis) });
  }
  assertDependencyExpectations({ projectId, ticket, expectations, sprintRegistry, ticketStatusStore });
  return expectations;
}

// Requires submitted dependency intent to equal the durable target claim before enqueue or inline provider launch.
export function assertDependencySubmission({ ticket, payload, projectId, sprintRegistry, ticketStatusStore }) {
  if (payload?.dependency_expectations === undefined) {
    if (payload?.sprint_basis || ticketStatusStore?.get?.(ticket?.id)?.details?.execution_basis || ticket?.sprint_id && sprintRegistry?.get?.(ticket.sprint_id)) throw conflict(ticket?.id);
    return; // Standalone work without Registry identity keeps its existing contract.
  }
  if (payload.review_resume && ticketStatusStore?.get?.(ticket?.id)?.details?.launch_claim) throw conflict(ticket.id);
  assertDependencyExpectations({ projectId, ticket, expectations: payload.dependency_expectations, sprintRegistry, ticketStatusStore });
  const basis = sprintRegistry?.get?.(ticket.sprint_id);
  if (!sameExecutionPlan(basis, payload.sprint_basis) || basis.version !== payload.sprint_basis.version || !["ready", "running"].includes(basis.status)) throw conflict(ticket.id);
  const current = ticketStatusStore?.get?.(ticket.id);
  if (!matchesTicketExecution(current, payload.execution_id, payload.sprint_basis) || !["running", "reviewing"].includes(current.status) || !isDeepStrictEqual(current.details.dependency_expectations, payload.dependency_expectations)) throw conflict(ticket.id);
}
