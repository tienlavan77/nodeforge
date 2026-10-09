// Projects approved immutable Registry scope into the Coding dashboard without legacy ticket overwrites.
import { sameExecutionPlan } from "../modules/projects/ticket-execution-identity.js";

// Returns Registry-owned Sprint scope and durable ticket status, or a scoped reconciliation diagnostic.
export async function getRegistryDashboard({ projectId, sprintRegistry, roadmap, metadata = [], ticketStatusStore }) {
  const records = sprintRegistry.list().filter((record) => record.project_id === projectId);
  const sprints = await Promise.all(records.map((record) => sprintRegistry.getDetail(record.sprint_id)));
  const registered = new Set(sprints.map((sprint) => sprint.id));
  const legacyIds = roadmap?.project_id === projectId ? (roadmap.sprints ?? []).map((sprint) => sprint.id) : [];
  const scopedMetadata = metadata.filter((entry) => entry.project_id === projectId);
  const missing = [...new Set([...legacyIds, ...scopedMetadata.map((entry) => entry.sprint_id)].filter((id) => !registered.has(id)))];
  if (missing.length) throw Object.assign(new Error("Legacy Sprint Plans must be reconciled before the Registry dashboard can be displayed."), { code: "SPRINT_REGISTRY_MIGRATION_REQUIRED", statusCode: 409, retryable: false, scope: "scoped", identifiers: missing });
  const entries = sprints.map((sprint) => {
    const ticketIds = sprint.ticket_ids ?? [];
    const extra = scopedMetadata.filter((entry) => entry.sprint_id === sprint.id && !ticketIds.includes(entry.id));
    if (extra.length) throw Object.assign(new Error("Persisted tickets outside immutable Sprint scope require reconciliation."), { code: "TICKET_PLAN_SCOPE", statusCode: 409, retryable: false, scope: "scoped", identifiers: extra.map((entry) => entry.id) });
    const tasks = (sprint.tickets ?? []).map((ticket) => {
      if (ticket.project_id !== projectId || ticket.sprint_id !== sprint.id) throw Object.assign(new Error("Immutable ticket ownership differs from the Registry Sprint."), { code: "SPRINT_PLAN_MISMATCH", statusCode: 409, retryable: false, scope: "scoped", identifiers: [sprint.id] });
      const persisted = ticketStatusStore?.get?.(ticket.id);
      if (persisted && persisted.project_id !== projectId) throw Object.assign(new Error("Ticket status ownership differs from the dashboard project."), { code: "TICKET_PLAN_SCOPE", statusCode: 409, retryable: false, scope: "scoped", identifiers: [sprint.id] });
      const basis = records.find((record) => record.sprint_id === sprint.id);
      const status = persisted && persisted.details?.execution_id && sameExecutionPlan(persisted.details.execution_basis, basis) ? persisted.status : ticketStatusStore ? "untracked" : "planned";
      return { id: ticket.id, title: ticket.title, priority: ticket.priority ?? "normal", status, progress: status === "done" ? 100 : ["running", "reviewing", "working"].includes(status) ? 50 : 0 };
    });
    return { id: sprint.id, objective: sprint.objective ?? null, order: sprint.order, status: sprint.status, ticket_ids: ticketIds, plan_id: sprint.plan_id, plan_revision: sprint.plan_revision, plan_sha256: sprint.plan_sha256, tasks };
  });
  for (const record of records) {
    if (sprintRegistry.get(record.sprint_id)?.version !== record.version) throw Object.assign(new Error("Sprint scheduling changed during dashboard projection; reload its current basis."), { code: "SPRINT_REGISTRY_CONFLICT", statusCode: 409, retryable: false, scope: "scoped", identifiers: [record.sprint_id] });
  }
  return structuredClone({ project_id: projectId, roadmap: entries.length ? { id: null, version: null, sprints: entries } : null });
}
