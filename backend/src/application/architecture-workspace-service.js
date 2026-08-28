import { ConfigurationError } from "../shared/errors.js";

// Application boundary for the read-only Architecture Workspace projection.
export function createArchitectureWorkspaceService({ knowledge, roadmaps, sprintPlans } = {}) {
  if (typeof knowledge?.getArchitecture !== "function" || typeof knowledge?.getStandards !== "function"
    || typeof knowledge?.getConstraints !== "function" || typeof knowledge?.getDecisions !== "function") {
    throw new ConfigurationError("Architecture Workspace Service requires an Architecture Knowledge Model.");
  }
  if (typeof roadmaps?.getCurrent !== "function" || typeof sprintPlans?.getCurrentSprint !== "function") {
    throw new ConfigurationError("Architecture Workspace Service requires Roadmap and Sprint Plan projections.");
  }

  return Object.freeze({ getWorkspace });

  function getWorkspace(projectId) {
    assertProjectId(projectId);
    const roadmap = roadmaps.getCurrent();
    if (roadmap && roadmap.project_id !== projectId) return emptyWorkspace(projectId);
    const currentSprintCandidate = sprintPlans.getCurrentSprint();
    const currentSprint = currentSprintCandidate?.project_id === projectId ? currentSprintCandidate : null;
    const decisions = knowledge.getDecisions().filter((decision) => decision.project_id === projectId);
    const architecture = decisions.filter(({ type }) => type === "architecture");
    const standards = decisions.filter(({ type }) => type === "standard");
    const constraints = decisions.filter(({ type }) => type === "constraint");
    return structuredClone({
      project_id: projectId,
      agent: { id: "architecture-manager", status: "READY" },
      architecture_plan: { architecture, standards, constraints },
      decisions,
      standards,
      constraints,
      roadmap: roadmap ?? null,
      sprint_breakdown: roadmap?.sprints ?? [],
      current_sprint: currentSprint ?? null
    });
  }
}

function emptyWorkspace(projectId) {
  return structuredClone({
    project_id: projectId,
    agent: { id: "architecture-manager", status: "READY" },
    architecture_plan: { architecture: [], standards: [], constraints: [] },
    decisions: [], standards: [], constraints: [], roadmap: null, sprint_breakdown: [], current_sprint: null
  });
}

function assertProjectId(projectId) {
  if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("An Architecture Workspace project id is required.");
}
