// Exposes immutable plan review and SQLite sprint scheduling through Forge v1.
import { ConfigurationError } from "../../shared/errors.js";
import { requireProject, unavailable } from "./forge-v1-router-utils.js";

// Rejects cross-project plan requests before reading or changing governance records.
function assertProject(projectId, expectedProjectId) {
  requireProject(projectId);
  if (projectId !== expectedProjectId) throw Object.assign(new ConfigurationError("Plan project context differs from the configured project."), { code: "PROJECT_CONTEXT_CONFLICT", statusCode: 409 });
}

// Routes exact plan revision, decision, and sprint registry operations.
export async function routePlan({ method, parts, body, projectId, expectedProjectId, planStore, markdownPlanStore, sprintRegistry, planOwnerAuth, headers } = {}) {
  if (parts[0] === "sprint-registry") throw Object.assign(new ConfigurationError("The sprint registry route has moved to /forge/v1/sprints/registry."), { code: "ROUTE_RETIRED", statusCode: 410 });
  if (!["plans", "sprints"].includes(parts[0]) || parts[0] === "sprints" && parts[1] !== "registry") return null;
  assertProject(projectId, expectedProjectId);
  if (parts[0] === "plans") {
    if (!planStore) throw unavailable("Human Plan");
    if (method === "GET" && parts.length === 1) return { status: 200, body: [...planStore.list(), ...(markdownPlanStore?.list?.() ?? [])] };
    if (method === "POST" && parts.length === 1) return { status: 201, body: await planStore.createRevision({ planId: body.plan_id, sprintId: body.sprint_id ?? null, content: body.content, proposalId: body.proposal_id ?? null, sourcePath: body.source_path ?? null, sourceSha256: body.source_sha256 ?? null, expectedRevision: 0 }) };
    if (method === "POST" && parts.length === 3 && parts[2] === "revisions") return { status: 201, body: await planStore.createRevision({ planId: parts[1], sprintId: body.sprint_id ?? null, content: body.content, proposalId: body.proposal_id ?? null, sourcePath: body.source_path ?? null, sourceSha256: body.source_sha256 ?? null, expectedRevision: body.expected_revision }) };
    if (method === "GET" && parts.length === 3) return { status: 200, body: await (markdownPlanStore?.list?.().some((item) => item.plan_id === parts[1]) ? markdownPlanStore.getRevision({ planId: parts[1], revision: Number(parts[2]) }) : planStore.getRevision({ planId: parts[1], revision: Number(parts[2]) })) };
    if (method === "POST" && parts.length === 4 && parts[3] === "decisions") {
      if (!planOwnerAuth?.verify) throw Object.assign(new ConfigurationError("Plan owner authentication is unavailable."), { code: "PLAN_OWNER_AUTH_UNCONFIGURED", statusCode: 503 });
      const approverId = planOwnerAuth.verify(headers);
      if (markdownPlanStore?.list?.().some((item) => item.plan_id === parts[1])) return { status: 201, body: await markdownPlanStore.decide({ planId: parts[1], revision: Number(parts[2]), sha256: body.sha256, decision: body.decision, approverId, comments: body.comments ?? null, decisionId: body.decision_id }) };
      return { status: 201, body: await planStore.decide({ planId: parts[1], revision: Number(parts[2]), sha256: body.sha256, sourceSha256: body.source_sha256 ?? null, decision: body.decision, approverId, actorRole: "project_owner", comments: body.comments ?? null, decisionId: body.decision_id }) };
    }
  }
  if (parts[0] === "sprints" && parts[1] === "registry") {
    if (!sprintRegistry) throw unavailable("Sprint Registry");
    if (method === "GET" && parts.length === 2) return { status: 200, body: sprintRegistry.list() };
    if (method === "POST" && parts.length === 2) return { status: 201, body: await sprintRegistry.register({ sprintId: body.sprint_id, position: body.position, dependencies: body.dependencies ?? [], planId: body.plan_id ?? null, revision: body.plan_revision ?? null, status: body.status }) };
    if (method === "GET" && parts.length === 3) return { status: 200, body: sprintRegistry.get(parts[2]) };
    if (method === "PUT" && parts.length === 4 && parts[3] === "plan") return { status: 200, body: await sprintRegistry.bindPlan({ sprintId: parts[2], planId: body.plan_id, revision: body.plan_revision, expectedVersion: body.expected_version }) };
    if (method === "PUT" && parts.length === 4 && parts[3] === "status") {
      if (!["ready", "blocked"].includes(body.status)) throw Object.assign(new ConfigurationError("Running and terminal sprint states are recorded by execution, not this API."), { code: "SPRINT_STATUS_AUTHORITY", statusCode: 403 });
      return { status: 200, body: await sprintRegistry.setStatus({ sprintId: parts[2], status: body.status, expectedVersion: body.expected_version }) };
    }
  }
  return null;
}
