import { ConfigurationError } from "../shared/errors.js";

// Application boundary for the read-only Architecture Workspace projection.
export function createArchitectureWorkspaceService({ knowledge } = {}) {
  if (typeof knowledge?.getArchitecture !== "function" || typeof knowledge?.getStandards !== "function"
    || typeof knowledge?.getConstraints !== "function" || typeof knowledge?.getDecisions !== "function") {
    throw new ConfigurationError("Architecture Workspace Service requires an Architecture Knowledge Model.");
  }
  return Object.freeze({ getWorkspace });

  function getWorkspace(projectId) {
    assertProjectId(projectId);
    const decisions = knowledge.getDecisions().filter((decision) => decision.project_id === projectId);
    const architecture = scoped(knowledge.getArchitecture(), projectId);
    const standards = scoped(knowledge.getStandards(), projectId);
    const constraints = scoped(knowledge.getConstraints(), projectId);
    return structuredClone({
      project_id: projectId,
      agent: { id: "architecture-manager", status: "READY" },
      architecture_plan: { architecture, standards, constraints },
      decisions
    });
  }

  function scoped(items, projectId) { return items.filter((item) => item.project_id === undefined || item.project_id === projectId); }
}

function assertProjectId(projectId) {
  if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("An Architecture Workspace project id is required.");
}
