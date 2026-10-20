// Supplies SL with execution-bound acceptance of completed prerequisites in the shared Sprint.
import { assertDependencyExpectations } from "./ticket-dependency-expectations.js";

// Projects dependency completion only after revalidating its captured plan and execution identities.
export function blockerDependencyProgress({ request, sprintRegistry, ticketStatusStore }) {
  if (!sprintRegistry || !ticketStatusStore || request.payload?.dependency_expectations === undefined) return { status: "unavailable", tickets: [] };
  const expectations = request.payload.dependency_expectations;
  assertDependencyExpectations({ projectId: request.project_id, ticket: request.ticket, expectations, sprintRegistry, ticketStatusStore });
  return { status: "validated", tickets: expectations.map((expected) => ({ ...expected, status: "done", acceptance: "accepted" })) };
}
