// Runs approved Registry-owned Sprint scope without letting stale callbacks overwrite newer execution state.
import { topologicalTicketLevels } from "../modules/supervisor/sprint-dag.js";
import { assertApprovedTicket } from "../modules/governance/sprint-plan-draft.js";
import { assertSprintTicketMembership } from "../modules/governance/sprint-plan-execution-gates.js";

// Captures the admitted Registry version for every Sprint RUN and its eventual terminal update.
export function createSprintRunDispatch({ projectId, sprintRegistry, sprintDagRunner, logEvent }) {
  return dispatchSprint;

  // Admits only a ready Project Sprint and executes tickets from its exact approved immutable revision.
  async function dispatchSprint({ projectId: requestedProjectId, sprintId } = {}) {
    if (requestedProjectId !== projectId) throw Object.assign(new Error("Sprint not found in this project."), { code: "SPRINT_NOT_FOUND", statusCode: 404 });
    const { sprint, plan } = await sprintRegistry.assertReady(sprintId);
    if (sprint.status !== "ready") throw Object.assign(new Error("Sprint is already running; reconcile its existing execution before another RUN."), { code: "SPRINT_ALREADY_RUNNING", statusCode: 409, retryable: false, scope: "scoped", identifiers: [sprintId] });
    const tickets = structuredClone(plan.content.ticket_specs ?? []);
    assertSprintTicketMembership(plan, tickets);
    for (const ticket of tickets) {
      if (ticket.project_id !== requestedProjectId || ticket.sprint_id !== sprintId) throw Object.assign(new Error("Approved ticket belongs to a different project or sprint."), { code: "SPRINT_PLAN_SCOPE", statusCode: 409 });
      assertApprovedTicket(plan, ticket);
    }
    if (!tickets.length) throw Object.assign(new Error("Sprint has no executable tickets."), { code: "SPRINT_PLAN_SCOPE", statusCode: 409 });
    const levels = topologicalTicketLevels(tickets);
    const admitted = await sprintRegistry.setStatus({ sprintId, status: "running", expectedVersion: sprint.version });
    const sprintBasis = Object.freeze({ project_id: admitted.project_id, sprint_id: admitted.sprint_id, version: admitted.version, plan_id: admitted.plan_id, plan_revision: admitted.plan_revision, plan_path: admitted.plan_path, plan_sha256: admitted.plan_sha256 });
    const execution = Promise.resolve().then(async () => {
      await sprintRegistry.assertReady(sprintId, { expectedVersion: sprintBasis.version });
      return sprintDagRunner.runSprintLevels({ projectId: requestedProjectId, sprintId, levels, sprintBasis });
    });
    execution.then(
      () => sprintRegistry.setStatus({ sprintId, status: "done", expectedVersion: sprintBasis.version }),
      async (error) => {
        logEvent({ event_name: "sprint.execution_failed", level: "error", status: "failed", message: "Sprint DAG execution failed.", project_id: requestedProjectId, source: "sprint-execution", payload: { sprint_id: sprintId, sprint_version: sprintBasis.version, error_code: error.code ?? "SPRINT_EXECUTION_FAILED", error: error.message } });
        await sprintRegistry.setStatus({ sprintId, status: "failed", expectedVersion: sprintBasis.version });
      }
    ).catch((error) => logEvent({ event_name: "sprint.registry_update_failed", level: "error", status: "failed", message: "Could not persist Sprint terminal status; reconciliation is required.", project_id: requestedProjectId, source: "sprint-execution", payload: { sprint_id: sprintId, sprint_version: sprintBasis.version, error_code: error.code, error: error.message } }));
    return { sprint_id: sprintId, status: "accepted", pipeline: "supervisor", execution: "sprint-execution", levels: levels.map((level) => level.map((ticket) => ticket.id)) };
  }
}
