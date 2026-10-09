// Loads Coding Sprint scope without hiding diagnostics or automatically retrying reconciliation conflicts.
import { normalizeUiError } from "./ui-error.js";
import { applyCodingTicketDeletions } from "./coding-ticket-deletion.js";

// Keeps the active Coding consumer's loading, available, and unavailable states distinct.
export function createCodingDashboardLoader({ client, projectId, onState, logger = console.error }) {
  let generation = 0;
  let lastError = null;
  let currentDashboard = null;
  const deletedSprintIds = new Set();
  const deletedTickets = new Map();
  return { load, cancel, removeSprint, removeTicket };

  // Removes only a confirmed deleted ticket and adopts the server's new Sprint revision without global loading.
  function removeTicket(ticketId, receipt = {}) {
    if (typeof ticketId !== "string" || !ticketId || (receipt.project_id && receipt.project_id !== projectId)) return;
    const previous = deletedTickets.get(ticketId);
    if (previous && (previous.version ?? -1) > (receipt.version ?? -1)) return;
    deletedTickets.set(ticketId, { ...previous, ...receipt });
    if (!currentDashboard) return;
    generation += 1;
    currentDashboard = withoutDeletedSprints(currentDashboard);
    if (!lastError) onState({ status: "ready", dashboard: currentDashboard, error: null });
  }

  // Removes only a confirmed deleted Sprint without refetching or remounting the remaining Coding cards.
  function removeSprint(sprintId) {
    if (typeof sprintId !== "string" || !sprintId) return;
    deletedSprintIds.add(sprintId);
    if (!currentDashboard) return;
    generation += 1;
    currentDashboard = withoutDeletedSprints(currentDashboard);
    if (lastError) return;
    onState({ status: "ready", dashboard: currentDashboard, error: null });
  }

  // Prevents an older in-flight response or delayed stream refresh from resurrecting a confirmed archive.
  function withoutDeletedSprints(dashboard) {
    if (!dashboard?.roadmap?.sprints) return dashboard;
    const sprints = dashboard.roadmap.sprints.filter((sprint) => !deletedSprintIds.has(sprint.id));
    return applyCodingTicketDeletions({ ...dashboard, roadmap: { ...dashboard.roadmap, sprints } }, deletedTickets);
  }

  // Ignores stale responses and stream refreshes after a non-retryable conflict; explicit reads may resume later.
  async function load({ manual = false } = {}) {
    if (!manual && lastError?.retryable === false) return;
    const current = ++generation;
    onState({ status: "loading", dashboard: null, error: null });
    try {
      const dashboard = await client.getProjectDashboard(projectId);
      if (current !== generation) return;
      if (dashboard?.project_id !== projectId) throw Object.assign(new Error("Dashboard response belongs to a different project."), { code: "PROJECT_CONTEXT_CONFLICT", retryable: false, scope: "scoped" });
      lastError = null;
      currentDashboard = withoutDeletedSprints(dashboard);
      onState({ status: "ready", dashboard: currentDashboard, error: null });
    } catch (error) {
      logger("Unable to load coding sprint dashboard", error);
      if (current !== generation) return;
      lastError = normalizeUiError(error, { fallback: "Sprint Plan is unavailable." });
      onState({ status: "error", dashboard: null, error: lastError });
    }
  }

  // Invalidates in-flight reads when the Coding page unmounts without permanently disabling remounts.
  function cancel() { generation += 1; }
}
