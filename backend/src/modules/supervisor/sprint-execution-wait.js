// Opens Sprint dependencies only from durable, attempt-scoped completion evidence for the approved immutable plan.
import { matchesTicketExecution, sameExecutionPlan, validExecutionBasis } from "../projects/ticket-execution-identity.js";
import { executionBasisSnapshot } from "./ticket-dependency-expectations.js";

// Rejects stale completion evidence instead of reusing a done status from another approved revision.
function executionError(ticketId) { return Object.assign(new Error(`Ticket ${ticketId} requires execution reconciliation for the current immutable plan.`), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409, retryable: false, scope: "scoped", identifiers: [ticketId] }); }

// Waits on committed Ticket status, not event type alone, and closes the pre-subscription completion race.
export function waitForTicketExecution({ ticketId, projectId, basis, executionId, ticketStatusStore, eventBus }) {
  return new Promise((resolve, reject) => {
    let unsubscribe;
    let finished = false;
    // Applies only the expected execution's persisted terminal state; stale or foreign events cannot open dependencies.
    const inspect = () => {
      const current = ticketStatusStore.get(ticketId);
      if (!matchesTicketExecution(current, executionId, basis)) { finish(executionError(ticketId)); return; }
      if (current.status === "done") finish();
      else if (["failed", "needs_human_review", "cancelled", "blocked"].includes(current.status)) finish(Object.assign(new Error(`Ticket ${ticketId} did not complete successfully.`), { code: "SPRINT_DEPENDENCY_FAILED" }));
    };
    // Releases the listener exactly once, including synchronous delivery while subscribing.
    const finish = (error) => { if (finished) return; finished = true; unsubscribe?.(); if (error) reject(error); else resolve(); };
    unsubscribe = eventBus.subscribe("*", (event) => {
      if (event?.task_id !== ticketId || event.project_id !== projectId || event.payload?.execution_id !== executionId || !["task.completed", "task.failed", "task.needs_human_review"].includes(event.type)) return;
      if (!sameExecutionPlan(event.payload.execution_basis, basis) || event.payload.execution_basis.version !== basis.version) return;
      inspect();
    });
    if (finished) unsubscribe?.();
    else inspect();
  });
}

// Rejects changed dependency plans or attempts after waiting, including changes while another dependency is resolved.
async function revalidateDependencies({ dependencies, sprintRegistry, ticketStatusStore }) {
  const observed = [];
  for (const dependency of dependencies) {
    const basis = dependency.local ? sprintRegistry?.get?.(dependency.basis.sprint_id) : await sprintRegistry?.getByTicket?.(dependency.ticketId);
    if (!validExecutionBasis(basis) || !sameExecutionPlan(basis, dependency.basis) || !["ready", "running", "done"].includes(basis.status)) throw executionError(dependency.ticketId);
    observed.push({ ...dependency, basis });
  }
  const expectations = [];
  // Makes the final checks synchronous so later resolution awaits cannot invalidate earlier checks unnoticed.
  for (const dependency of observed) {
    const currentBasis = sprintRegistry?.get?.(dependency.basis.sprint_id);
    const current = ticketStatusStore.get(dependency.ticketId);
    if (!sameExecutionPlan(currentBasis, dependency.basis) || currentBasis.version !== dependency.basis.version || !["ready", "running", "done"].includes(currentBasis.status) || current?.status !== "done" || current.details?.execution_id !== dependency.executionId || !sameExecutionPlan(current.details.execution_basis, dependency.basis)) throw executionError(dependency.ticketId);
    expectations.push({ ticket_id: dependency.ticketId, execution_id: dependency.executionId, execution_basis: executionBasisSnapshot(current.details.execution_basis), sprint_basis: executionBasisSnapshot(currentBasis) });
  }
  return expectations;
}

// Runs the production DAG with Registry plan identity and durable attempt-aware dependency gates.
export async function runFencedSprintLevels({ projectId, levels, sprintBasis, ticketStatusStore, eventBus, dispatchTask, sprintRegistry }) {
  if (!validExecutionBasis(sprintBasis) || sprintBasis.project_id !== projectId) throw executionError("Sprint");
  const localIds = new Set(levels.flat().map((ticket) => ticket.id));
  const results = [];
  for (const level of levels) {
    const dispatched = [];
    for (const ticket of level) {
      const current = ticketStatusStore.get(ticket.id);
      if (current?.status === "done") {
        if (!current.details.execution_id || !sameExecutionPlan(current.details.execution_basis, sprintBasis)) throw executionError(ticket.id);
        results.push({ ticket_id: ticket.id, result: { status: "completed", reused: true, execution_id: current.details.execution_id } });
        continue;
      }
      const dependencies = [];
      for (const dependencyId of ticket.dependencies ?? []) {
        const basis = localIds.has(dependencyId) ? sprintBasis : await sprintRegistry?.getByTicket?.(dependencyId);
        const dependency = ticketStatusStore.get(dependencyId);
        if (!validExecutionBasis(basis) || basis.project_id !== projectId || !dependency?.details.execution_id || !sameExecutionPlan(dependency.details.execution_basis, basis)) throw executionError(dependencyId);
        dependencies.push({ ticketId: dependencyId, basis, executionId: dependency.details.execution_id, local: localIds.has(dependencyId) });
        if (dependency.status !== "done") await waitForTicketExecution({ ticketId: dependencyId, projectId, basis: dependency.details.execution_basis, executionId: dependency.details.execution_id, ticketStatusStore, eventBus });
      }
      const dependencyExpectations = await revalidateDependencies({ dependencies, sprintRegistry, ticketStatusStore });
      const result = await dispatchTask({ ticket: { ...ticket, project_id: ticket.project_id ?? projectId }, sprintBasis, dependencyExpectations });
      if (!result.execution_id) throw executionError(ticket.id);
      dispatched.push({ ticket_id: ticket.id, result });
    }
    results.push(...dispatched);
    await Promise.all(dispatched.map(({ ticket_id: ticketId, result }) => {
      const current = ticketStatusStore.get(ticketId);
      if (!sameExecutionPlan(current?.details.execution_basis, sprintBasis)) throw executionError(ticketId);
      return waitForTicketExecution({ ticketId, projectId, basis: current.details.execution_basis, executionId: result.execution_id, ticketStatusStore, eventBus });
    }));
  }
  return results;
}
