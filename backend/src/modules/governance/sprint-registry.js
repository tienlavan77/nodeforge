// Schedules project sprints from approved immutable plans instead of roadmap snapshots.
import { ConfigurationError } from "../../shared/errors.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STATUSES = new Set(["planned", "awaiting_human_approval", "ready", "running", "done", "failed", "blocked"]);

// Returns a stable gate error when scheduling or approval evidence is invalid.
function fail(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }

// Creates the authoritative SQLite sprint registry for a project.
export function createSprintRegistry({ projectId, database, plans, clock = () => new Date().toISOString() } = {}) {
  if (!projectId || !database?.all || !database?.run || !plans?.getRevision || !plans?.assertExecutable) throw fail("SPRINT_REGISTRY_CONFIG", "Sprint registry requires a database and plan store.");
  return Object.freeze({ register, get, getDetail, list, listDetails, bindPlan, setStatus, assertReady, getByTicket });

  // Converts a stored row to its public scheduling record.
  function project(row) { return row && { sprint_id: row.sprint_id, project_id: row.project_id, position: row.position, dependencies: JSON.parse(row.dependencies_json), status: row.status, plan_id: row.plan_id, plan_revision: row.plan_revision, plan_path: row.plan_path, plan_sha256: row.plan_sha256, created_at: row.created_at, updated_at: row.updated_at }; }

  // Registers one sprint with an exact plan reference and explicit order.
  async function register({ sprintId, position, dependencies = [], planId = null, revision = null, status } = {}) {
    if (!SAFE_ID.test(sprintId ?? "") || !Number.isSafeInteger(position) || position < 0 || !Array.isArray(dependencies) || dependencies.some((id) => !SAFE_ID.test(id) || id === sprintId) || new Set(dependencies).size !== dependencies.length) throw fail("SPRINT_REGISTRY_INPUT", "Sprint ID, order, and dependencies are invalid.");
    if (get(sprintId)) throw fail("SPRINT_REGISTRY_EXISTS", "Sprint already exists in registry.");
    const plan = planId === null && revision === null ? null : await plans.getRevision({ planId, revision });
    if (plan && plan.sprint_id !== sprintId) throw fail("SPRINT_PLAN_MISMATCH", "Plan revision is not assigned to this sprint.");
    const initialStatus = status ?? (plan ? "awaiting_human_approval" : "planned");
    if (!["planned", "awaiting_human_approval", "blocked"].includes(initialStatus)) throw fail("SPRINT_REGISTRY_INPUT", "A new sprint may only be planned, awaiting approval, or blocked.");
    for (const id of dependencies) {
      const dependency = get(id);
      if (!dependency || dependency.position >= position) throw fail("SPRINT_DEPENDENCY_INVALID", "Sprint dependency must exist earlier in project order.");
    }
    const now = clock();
    database.run("INSERT INTO sprint_registry(sprint_id,project_id,position,dependencies_json,status,plan_id,plan_revision,plan_path,plan_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [sprintId, projectId, position, JSON.stringify(dependencies), initialStatus, plan?.plan_id ?? null, plan?.revision ?? null, plan?.file_path ?? null, plan?.sha256 ?? null, now, now]);
    return get(sprintId);
  }

  // Reads scheduling state only from SQLite.
  function get(sprintId) {
    if (!SAFE_ID.test(sprintId ?? "")) throw fail("SPRINT_REGISTRY_INPUT", "A valid sprint ID is required.");
    return project(database.all("SELECT * FROM sprint_registry WHERE project_id=? AND sprint_id=?", [projectId, sprintId])[0]);
  }

  // Resolves the canonical project sprint view from its registry record and bound immutable plan.
  async function getDetail(sprintId) {
    const sprint = get(sprintId);
    if (!sprint) return null;
    if (!sprint.plan_id) return { id: sprint.sprint_id, project_id: sprint.project_id, dependencies: sprint.dependencies, status: sprint.status, order: sprint.position + 1, tickets: [], exit_criteria: [] };
    const plan = await plans.getRevision({ planId: sprint.plan_id, revision: sprint.plan_revision });
    const ticketIds = structuredClone(plan.content.tickets);
    const tickets = structuredClone((plan.content.ticket_specs ?? []).filter((ticket) => ticketIds.includes(ticket.id)));
    return { id: sprint.sprint_id, project_id: sprint.project_id, objective: plan.content.objective, dependencies: sprint.dependencies, status: sprint.status, order: sprint.position + 1, ticket_ids: ticketIds, tickets, exit_criteria: structuredClone(plan.content.acceptance_criteria), plan_id: sprint.plan_id, plan_revision: sprint.plan_revision, plan_sha256: sprint.plan_sha256 };
  }

  // Lists sprints in their explicit execution order.
  function list() { return database.all("SELECT * FROM sprint_registry WHERE project_id=? ORDER BY position", [projectId]).map(project); }

  // Builds the Registry-owned detail collection used by the public sprint list.
  async function listDetails() { return Promise.all(list().map(({ sprint_id: sprintId }) => getDetail(sprintId))); }

  // Rebinds a sprint after replanning; prior approval cannot authorize the new revision.
  async function bindPlan({ sprintId, planId, revision } = {}) {
    const sprint = get(sprintId);
    if (!sprint) throw fail("SPRINT_NOT_FOUND", "Sprint is not registered.");
    if (sprint.status === "running") throw fail("SPRINT_REPLAN_RUNNING", "A running sprint must stop before its execution basis changes.");
    const plan = await plans.getRevision({ planId, revision });
    if (plan.sprint_id !== sprintId) throw fail("SPRINT_PLAN_MISMATCH", "Plan revision is not assigned to this sprint.");
    database.run("UPDATE sprint_registry SET plan_id=?,plan_revision=?,plan_path=?,plan_sha256=?,status='awaiting_human_approval',updated_at=? WHERE sprint_id=? AND project_id=?", [planId, revision, plan.file_path, plan.sha256, clock(), sprintId, projectId]);
    return get(sprintId);
  }

  // Verifies the plan file, approval, and completed sprint dependencies.
  async function assertReady(sprintId) {
    const sprint = get(sprintId);
    if (!sprint) throw fail("SPRINT_NOT_FOUND", "Sprint is not registered.");
    const plan = await plans.assertExecutable({ planId: sprint.plan_id, revision: sprint.plan_revision, sha256: sprint.plan_sha256 });
    if (plan.file_path !== sprint.plan_path) throw fail("SPRINT_PLAN_MISMATCH", "Sprint plan path differs from the approved index.");
    const unfinished = sprint.dependencies.filter((id) => get(id)?.status !== "done");
    if (unfinished.length) throw fail("SPRINT_DEPENDENCIES_NOT_READY", `Sprint dependencies are unfinished: ${unfinished.join(", ")}.`);
    if (!["ready", "running"].includes(sprint.status)) throw fail("SPRINT_NOT_READY", "Sprint has not been marked ready for execution.");
    return { sprint, plan };
  }

  // Changes lifecycle state without modifying the referenced immutable plan.
  async function setStatus({ sprintId, status } = {}) {
    const sprint = get(sprintId);
    if (!sprint || !STATUSES.has(status)) throw fail("SPRINT_REGISTRY_INPUT", "Sprint and valid status are required.");
    const transitions = { planned: ["ready", "awaiting_human_approval", "blocked"], awaiting_human_approval: ["ready", "blocked"], ready: ["running", "blocked"], running: ["done", "failed", "blocked"], failed: ["ready", "blocked"], blocked: ["ready"], done: [] };
    if (status !== sprint.status && !transitions[sprint.status]?.includes(status)) throw fail("SPRINT_STATUS_TRANSITION", "Sprint lifecycle transition is not allowed.");
    if (["ready", "running"].includes(status)) {
      if (!sprint.plan_id || !Number.isSafeInteger(sprint.plan_revision) || !sprint.plan_sha256) throw fail("PLAN_APPROVAL_REQUIRED", "A sprint needs an approved immutable plan before it can become ready.");
      const plan = await plans.assertExecutable({ planId: sprint.plan_id, revision: sprint.plan_revision, sha256: sprint.plan_sha256 });
      if (plan.file_path !== sprint.plan_path) throw fail("SPRINT_PLAN_MISMATCH", "Sprint plan path differs from the approved index.");
      if (sprint.dependencies.some((id) => get(id)?.status !== "done")) throw fail("SPRINT_DEPENDENCIES_NOT_READY", "Sprint dependencies are unfinished.");
    }
    if (status === "done") await plans.assertExecutable({ planId: sprint.plan_id, revision: sprint.plan_revision, sha256: sprint.plan_sha256 });
    database.run("UPDATE sprint_registry SET status=?,updated_at=? WHERE sprint_id=? AND project_id=?", [status, clock(), sprintId, projectId]);
    return get(sprintId);
  }

  // Resolves a ticket only from the current registered sprint plan.
  async function getByTicket(ticketId) {
    for (const sprint of list()) {
      const plan = await plans.getRevision({ planId: sprint.plan_id, revision: sprint.plan_revision });
      if (plan.content.tickets.includes(ticketId)) return sprint;
    }
    return null;
  }
}
