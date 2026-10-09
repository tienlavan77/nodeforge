// Routes public Sprint CRUD through Registry when configured, retaining legacy support only for standalone deployments.
import { createRegistrySprintCrudService } from "../../application/registry-sprint-crud-service.js";
import { requireProject, unavailable } from "./forge-v1-router-utils.js";

// Rejects incomplete cutover or wrong project rather than writing into a different governance authority.
function conflict(code, message, statusCode = 409) { return Object.assign(new Error(message), { code, statusCode, retryable: false, scope: "scoped" }); }

// Keeps Sprint list/detail/create/replan/archive on the same authoritative store and preserves checkpoint decoration.
export async function routeSprintCrud({ method, parts, body, url, projectId, expectedProjectId, sprintRegistry, planStore, sprintPlanUploadService, conversationRoutes }) {
  if (parts[0] !== "sprints" || parts.length > 2 || parts[1] === "registry" || parts[1]?.endsWith(":run")) return null;
  if (!["GET", "POST", "PUT", "DELETE"].includes(method) || parts.length === 1 && ["PUT", "DELETE"].includes(method) || parts.length === 2 && method === "POST") return null;
  requireProject(projectId);
  if (expectedProjectId && projectId !== expectedProjectId) throw conflict("PROJECT_CONTEXT_CONFLICT", "Sprint project differs from the configured runtime.");
  const sprintId = parts[1];
  if (sprintRegistry) {
    if (method === "GET") {
      if (!sprintId) {
        const registered = await sprintRegistry.listDetails();
        const legacy = sprintPlanUploadService?.list?.({ projectId }) ?? [];
        const activeIds = new Set(registered.map((sprint) => sprint.id));
        const pending = legacy.filter((sprint) => !activeIds.has(sprint.id) && !sprintRegistry.isArchived?.(sprint.id));
        if (pending.length) throw Object.assign(conflict("SPRINT_REGISTRY_MIGRATION_REQUIRED", "Legacy Sprint Plans must be migrated before Registry list cutover."), { identifiers: pending.map((sprint) => sprint.id) });
        return { status: 200, body: await conversationRoutes.withCheckpointSummary(registered) };
      }
      const detail = await sprintRegistry.getDetail(sprintId);
      if (!detail) throw conflict("SPRINT_NOT_FOUND", "Sprint is not active in Registry.", 404);
      return { status: 200, body: detail };
    }
    if (!planStore || !expectedProjectId) throw unavailable("Registry Sprint CRUD");
    const service = createRegistrySprintCrudService({ projectId: expectedProjectId, registry: sprintRegistry, plans: planStore });
    if (method === "POST") return { status: 201, body: await service.create({ sprintPlan: body.sprint_plan ?? body, position: body.position }) };
    if (method === "PUT") return { status: 200, body: await service.update({ sprintId, sprintPlan: body.sprint_plan ?? body, expectedVersion: body.expected_version }) };
    const expected = url.searchParams.get("expected_version");
    if (expected === null || !/^\d+$/.test(expected)) throw conflict("SPRINT_REGISTRY_CONFLICT", "Delete requires expected_version from the current Sprint detail.");
    return { status: 200, body: service.remove({ sprintId, expectedVersion: Number(expected) }) };
  }
  if (!sprintPlanUploadService) throw unavailable("Sprint Plan");
  if (method === "POST") return { status: 201, body: await sprintPlanUploadService.upload({ projectId, sprintPlan: body.sprint_plan ?? body }) };
  if (method === "GET") return { status: 200, body: sprintId ? await sprintPlanUploadService.get({ projectId, sprintId }) : await conversationRoutes.withCheckpointSummary(await sprintPlanUploadService.list({ projectId })) };
  if (method === "PUT") return { status: 200, body: await sprintPlanUploadService.update({ projectId, sprintId, sprintPlan: body.sprint_plan ?? body }) };
  return { status: 200, body: await sprintPlanUploadService.remove({ projectId, sprintId }) };
}
