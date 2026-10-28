// Provides module declarations and business logic for architecture-workspace-service.js.

import { ConfigurationError } from "../shared/errors.js";

// Application boundary for the read-only Architecture Workspace projection.
export function createArchitectureWorkspaceService({ knowledge } = {}) {
  if (typeof knowledge?.getArchitecture !== "function" || typeof knowledge?.getStandards !== "function"
    || typeof knowledge?.getConstraints !== "function" || typeof knowledge?.getDecisions !== "function") {
    throw new ConfigurationError("Architecture Workspace Service requires an Architecture Knowledge Model.");
  }
  return Object.freeze({ getWorkspace });
  // Defines getWorkspace function behavior for architecture-workspace-service.js.
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
  // Defines scoped function behavior for architecture-workspace-service.js.
  function scoped(items, projectId) { return items.filter((item) => item.project_id === undefined || item.project_id === projectId); }
}

// Validates that a project ID is a non-empty string.
function assertProjectId(projectId) {
  if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("An Architecture Workspace project id is required.");
}
