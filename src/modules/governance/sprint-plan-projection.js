import { ConfigurationError } from "../../shared/errors.js";

export function createSprintPlanProjection({ roadmaps } = {}) {
  if (typeof roadmaps?.getCurrent !== "function") throw new ConfigurationError("Sprint Plan Projection requires a Roadmap Store.");

  return Object.freeze({ getCurrentSprint, getSprintById, getSprintBacklog, getSprintStatus });

  function getCurrentSprint() {
    return cloneSprint(currentRoadmap()?.sprints[0]);
  }

  function getSprintById(id) {
    if (typeof id !== "string" || id.length === 0) throw new ConfigurationError("A sprint id is required.");
    return cloneSprint(currentRoadmap()?.sprints.find((sprint) => sprint.id === id));
  }

  function getSprintBacklog(id) {
    const sprint = getRequiredSprint(id);
    return sprint.tickets.map((ticket) => structuredClone(ticket));
  }

  function getSprintStatus(id) {
    const sprint = getRequiredSprint(id);
    const completed = sprint.tickets.filter((ticket) => ticket.status === "done").length;
    return Object.freeze({
      sprint_id: sprint.id,
      status: completed === sprint.tickets.length && sprint.tickets.length > 0 ? "done" : sprint.tickets.some((ticket) => ticket.status === "running") ? "running" : "planned",
      ticket_count: sprint.tickets.length,
      completed_ticket_count: completed
    });
  }

  function getRequiredSprint(id) {
    const sprint = getSprintById(id);
    if (!sprint) throw new ConfigurationError(`Unknown Sprint Plan: ${id}.`);
    return sprint;
  }

  function currentRoadmap() {
    return roadmaps.getCurrent();
  }
}

function cloneSprint(sprint) {
  return sprint ? structuredClone(sprint) : undefined;
}
