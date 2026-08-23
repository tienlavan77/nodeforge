import { ConfigurationError } from "../shared/errors.js";

// Read-only Node projection; canonical roadmap and provenance remain in governance modules.
export function createProjectDashboardService({ roadmaps, sprintPlans, provenance } = {}) {
  if (typeof roadmaps?.getCurrent !== "function" || typeof sprintPlans?.getCurrentSprint !== "function"
    || typeof sprintPlans?.getSprintStatus !== "function" || typeof sprintPlans?.getSprintBacklog !== "function") {
    throw new ConfigurationError("Project Dashboard Service requires Roadmap and Sprint Plan projections.");
  }
  if (provenance !== undefined && typeof provenance?.validateProvenance !== "function") {
    throw new ConfigurationError("Project Dashboard provenance must provide validateProvenance().");
  }

  return Object.freeze({ getDashboard });

  function getDashboard(projectId) {
    assertProjectId(projectId);
    const roadmap = roadmaps.getCurrent();
    if (!roadmap || roadmap.project_id !== projectId) return emptyDashboard(projectId);
    const sprint = sprintPlans.getCurrentSprint();
    if (!sprint) return emptyDashboard(projectId, roadmap);
    const status = sprintPlans.getSprintStatus(sprint.id);
    const tickets = sprintPlans.getSprintBacklog(sprint.id).map((ticket) => ticketView(ticket));
    return structuredClone({
      project_id: projectId,
      roadmap: { id: roadmap.id, version: roadmap.version, sprints: roadmap.sprints.map((item, index) => ({ id: item.id, objective: item.objective, order: index + 1, status: item.id === sprint.id ? status.status : "planned" })) },
      current_sprint: { id: sprint.id, objective: sprint.objective, ...status },
      backlog: tickets
    });
  }

  function ticketView(ticket) {
    let chain;
    try {
      const value = provenance?.validateProvenance(ticket);
      chain = value ? {
        architecture_decision_ids: value.architecture_decisions.map(({ id }) => id),
        roadmap_id: value.roadmap.id,
        sprint_id: value.sprint.id
      } : undefined;
    } catch {
      chain = undefined;
    }
    return {
      id: ticket.id,
      title: ticket.title,
      priority: ticket.priority ?? "normal",
      status: ticket.status ?? "planned",
      progress: ticket.status === "done" ? 100 : ticket.status === "running" || ticket.status === "reviewing" ? 50 : 0,
      sprint_id: ticket.sprint_id,
      ...(ticket.owner ? { owner: ticket.owner } : {}),
      ...(ticket.commit_id ? { commit_id: ticket.commit_id } : {}),
      ...(chain ? { provenance: chain } : {})
    };
  }
}

function emptyDashboard(projectId, roadmap = null) {
  return { project_id: projectId, roadmap: roadmap ? { id: roadmap.id, version: roadmap.version, sprints: [] } : null, current_sprint: null, backlog: [] };
}

function assertProjectId(projectId) {
  if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A Project Dashboard project id is required.");
}
