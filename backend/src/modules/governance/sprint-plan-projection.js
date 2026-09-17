// Projection over the roadmap store that resolves current sprint, backlog, and ticket status.
import { ConfigurationError } from "../../shared/errors.js";

// Creates a projection over the roadmap store for sprint reads.
export function createSprintPlanProjection({ roadmaps } = {}) {
  if (typeof roadmaps?.getCurrent !== "function") throw new ConfigurationError("Sprint Plan Projection requires a Roadmap Store.");

  return Object.freeze({ getCurrentSprint, getSprintById, getSprintBacklog, getSprintStatus });

  // Returns the active sprint or the first sprint as fallback.
  function getCurrentSprint() {
    const sprints = currentRoadmap()?.sprints ?? [];
    const active = [...sprints].reverse().find((sprint) => (sprint.tickets ?? []).some((ticket) => ["pending", "running", "reviewing"].includes(ticket.status)));
    return cloneSprint(active ?? sprints[0]);
  }

  // Returns a sprint by its identifier.
  function getSprintById(id) {
    if (typeof id !== "string" || id.length === 0) throw new ConfigurationError("A sprint id is required.");
    return cloneSprint(currentRoadmap()?.sprints.find((sprint) => sprint.id === id));
  }

  // Returns cloned tickets belonging to a sprint.
  function getSprintBacklog(id) {
    const sprint = getRequiredSprint(id);
    return sprint.tickets.map((ticket) => structuredClone(ticket));
  }

  // Computes aggregate status and counts for a sprint.
  function getSprintStatus(id) {
    const sprint = getRequiredSprint(id);
    const completed = sprint.tickets.filter((ticket) => ticket.status === "done").length;
    const failed = sprint.tickets.filter((ticket) => ticket.status === "failed").length;
    const terminal = completed + failed === sprint.tickets.length && sprint.tickets.length > 0;
    const status = terminal ? (failed > 0 ? "completed_with_errors" : "done") : sprint.tickets.some((ticket) => ["pending", "running", "reviewing"].includes(ticket.status)) ? "running" : "planned";
    return Object.freeze({
      sprint_id: sprint.id,
      status,
      ticket_count: sprint.tickets.length,
      completed_ticket_count: completed,
      failed_ticket_count: failed
    });
  }

  // Returns a sprint or throws if it does not exist.
  function getRequiredSprint(id) {
    const sprint = getSprintById(id);
    if (!sprint) throw new ConfigurationError(`Unknown Sprint Plan: ${id}.`);
    return sprint;
  }

  // Returns the latest roadmap snapshot.
  function currentRoadmap() {
    return roadmaps.getCurrent();
  }
}

// Deep-clones a sprint or returns undefined.
function cloneSprint(sprint) {
  return sprint ? structuredClone(sprint) : undefined;
}
