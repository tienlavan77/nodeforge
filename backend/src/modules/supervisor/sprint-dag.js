import { ConfigurationError } from "../../shared/errors.js";

export function topologicalTicketLevels(tickets = []) {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const remaining = new Map(tickets.map((ticket) => [ticket.id, new Set((ticket.dependencies ?? []).filter((dependency) => byId.has(dependency)))]));
  const levels = [];
  while (remaining.size) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => byId.get(id))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!ready.length) {
      const error = new ConfigurationError("Sprint ticket dependencies contain a cycle.");
      error.code = "SPRINT_DEPENDENCY_CYCLE";
      throw error;
    }
    levels.push(ready);
    for (const ticket of ready) remaining.delete(ticket.id);
    for (const dependencies of remaining.values()) for (const ticket of ready) dependencies.delete(ticket.id);
  }
  return levels;
}

export function createSprintDagRunner({ ticketStatusStore, eventBus, dispatchTask, logEvent = () => {} } = {}) {
  if (typeof ticketStatusStore?.dependenciesReady !== "function" || typeof ticketStatusStore?.getStatus !== "function") throw new ConfigurationError("Sprint DAG requires a Ticket Status Store.");
  if (typeof eventBus?.subscribe !== "function") throw new ConfigurationError("Sprint DAG requires an execution event bus.");
  if (typeof dispatchTask !== "function") throw new ConfigurationError("Sprint DAG requires a dispatch function.");
  return Object.freeze({ runSprintLevels });

  async function runSprintLevels({ projectId, sprintId, levels }) {
    const results = [];
    for (const level of levels) {
      const dispatched = [];
      for (const ticket of level) {
        const dependencies = ticket.dependencies ?? [];
        if (!ticketStatusStore.dependenciesReady(ticket.id, dependencies).ready) {
          await waitForDependencies({ ticketId: ticket.id, dependencies, sprintId, projectId });
        }
        const normalized = { ...ticket, project_id: ticket.project_id ?? projectId };
        const result = await dispatchTask({ ticket: normalized, message: { id: `REQ-${ticket.id}-${Date.now()}`, correlation_id: `CORR-UI-RUN-${sprintId}-${ticket.id}-${Date.now()}` } });
        dispatched.push({ ticket_id: ticket.id, result });
      }
      results.push(...dispatched);
      await Promise.all(dispatched.map(({ ticket_id }) => waitForTerminalEvent(ticket_id)));
    }
    return results;
  }

  async function waitForDependencies({ ticketId, dependencies, sprintId, projectId }) {
    const readiness = ticketStatusStore.dependenciesReady(ticketId, dependencies);
    if (readiness.ready) return;
    const error = new Error(`Ticket ${ticketId} is blocked by unfinished dependencies.`);
    error.code = "SPRINT_DEPENDENCIES_NOT_READY";
    logEvent({ event_name: "sprint.ticket_blocked", level: "info", status: "blocked", message: error.message, project_id: projectId, source: "sprint-execution", payload: { sprint_id: sprintId, ticket_id: ticketId, blocked_by: readiness.blocked_by } });
    await Promise.all(readiness.blocked_by.map(({ id }) => waitForTerminalEvent(id)));
    const after = ticketStatusStore.dependenciesReady(ticketId, dependencies);
    if (!after.ready) { error.message = `Ticket ${ticketId} dependencies did not complete successfully.`; error.code = "SPRINT_DEPENDENCY_FAILED"; throw error; }
  }

  function waitForTerminalEvent(ticketId) {
    const current = ticketStatusStore.getStatus(ticketId);
    if (current === "done") return Promise.resolve();
    if (current === "failed" || current === "needs_human_review" || current === "cancelled") {
      return Promise.reject(Object.assign(new Error(`Ticket dependency did not complete: ${ticketId} (${current}).`), { code: "SPRINT_DEPENDENCY_FAILED" }));
    }
    return new Promise((resolve, reject) => {
      let unsubscribe;
      const finish = (error) => { unsubscribe?.(); if (error) reject(error); else resolve(); };
      unsubscribe = eventBus.subscribe("*", (event) => {
        if (event?.task_id !== ticketId || !["task.completed", "task.failed"].includes(event.type)) return;
        if (event.type === "task.completed") finish();
        else finish(Object.assign(new Error(`Ticket failed: ${ticketId}.`), { code: "SPRINT_DEPENDENCY_FAILED" }));
      });
    });
  }
}
