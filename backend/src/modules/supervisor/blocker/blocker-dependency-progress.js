// Supplies SL with execution-bound acceptance of completed prerequisites in the shared Sprint.
import { assertDependencyExpectations } from "../ticket/ticket-dependency-expectations.js";

// Projects dependency completion only after revalidating its captured plan and execution identities.
export function blockerDependencyProgress({ request, job, sprintRegistry, ticketStatusStore }) {
  if (!sprintRegistry || !ticketStatusStore || request.payload?.dependency_expectations === undefined) return { status: "unavailable", tickets: [] };
  const expectations = request.payload.dependency_expectations;
  const repairing = new Set();
  // Validates the retained execution identity independently of the temporary status introduced by its own dependency repair.
  const observed = { get: (id) => {
    const current = ticketStatusStore.get(id), binding = current?.details.dependency_repair;
    if (job?.dependency_request_id && binding?.id === job.dependency_request_id && binding.parent_ticket_id === request.task_id
      && binding.parent_execution_id === request.payload.execution_id && ["pending", "failed", "running", "reviewing"].includes(current.status)) {
      repairing.add(id);
      return { ...current, status: "done" };
    }
    return current;
  } };
  // Coordination can describe an admitted repair in progress; plan and execution identities still undergo the original validation.
  assertDependencyExpectations({ projectId: request.project_id, ticket: request.ticket, expectations, sprintRegistry, ticketStatusStore: observed });
  return { status: repairing.size ? "repair_pending" : "validated", tickets: expectations.map((expected) => ({ ...expected,
    status: repairing.has(expected.ticket_id) ? ticketStatusStore.get(expected.ticket_id).status : "done",
    acceptance: repairing.has(expected.ticket_id) ? "pending" : "accepted" })) };
}
