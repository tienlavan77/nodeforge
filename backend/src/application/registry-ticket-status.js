// Keeps dashboard, ticket View and graph status aligned with the current immutable plan execution.
import { sameExecutionPlan } from "../modules/projects/ticket-execution-identity.js";

// Projects durable execution status without mistaking planned or obsolete ticket evidence for current work.
export function registryTicketStatus({ ticket, basis, ticketStatusStore }) {
  const persisted = ticketStatusStore?.get?.(ticket.id);
  if (persisted && persisted.project_id !== ticket.project_id) throw Object.assign(new Error("Ticket status ownership differs from the requested project."), { code: "TICKET_PLAN_SCOPE", statusCode: 409, retryable: false, scope: "scoped", identifiers: [ticket.sprint_id] });
  const status = persisted?.details?.execution_id && sameExecutionPlan(persisted.details.execution_basis, basis) ? persisted.status : ticketStatusStore ? "untracked" : "planned";
  return { status, progress: status === "done" ? 100 : ["running", "reviewing", "working"].includes(status) ? 50 : 0 };
}
