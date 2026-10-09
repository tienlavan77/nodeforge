// Schedules project sprints from approved immutable plans instead of roadmap snapshots.
import { ConfigurationError } from "../../shared/errors.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STATUSES = new Set(["planned", "awaiting_human_approval", "ready", "running", "done", "failed", "blocked"]);

// Returns a stable gate error when scheduling or approval evidence is invalid.
function fail(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }

// Creates the authoritative SQLite sprint registry for a project.
export function createSprintRegistry({ projectId, database, plans, clock = () => new Date().toISOString() } = {}) {
  if (!projectId || !database?.all || !database?.run || !plans?.getRevision || !plans?.assertExecutable) throw fail("SPRINT_REGISTRY_CONFIG", "Sprint registry requires a database and plan store.");
  return Object.freeze({ register, get, getDetail, list, listDetails, bindPlan, setStatus, assertReady, getByTicket, archive, isArchived, assertMutable });

  // Converts a stored row to its public scheduling record.
  function project(row) { return row && { sprint_id: row.sprint_id, project_id: row.project_id, position: row.position, dependencies: JSON.parse(row.dependencies_json), status: row.status, version: row.version, plan_id: row.plan_id, plan_revision: row.plan_revision, plan_path: row.plan_path, plan_sha256: row.plan_sha256, created_at: row.created_at, updated_at: row.updated_at }; }

  // Registers one sprint with an exact plan reference and explicit order.
  async function register({ sprintId, position, dependencies = [], planId = null, revision = null, status } = {}) {
    if (!SAFE_ID.test(sprintId ?? "") || !Number.isSafeInteger(position) || position < 0 || !Array.isArray(dependencies) || dependencies.some((id) => !SAFE_ID.test(id) || id === sprintId) || new Set(dependencies).size !== dependencies.length) throw fail("SPRINT_REGISTRY_INPUT", "Sprint ID, order, and dependencies are invalid.");
    if (get(sprintId, { includeArchived: true })) throw fail("SPRINT_REGISTRY_EXISTS", "Sprint identity already exists, including retained archives.");
    const plan = planId === null && revision === null ? null : await plans.getRevision({ planId, revision });
    if (plan && plan.sprint_id !== sprintId) throw fail("SPRINT_PLAN_MISMATCH", "Plan revision is not assigned to this sprint.");
    const initialStatus = status ?? (plan ? "awaiting_human_approval" : "planned");
    if (!["planned", "awaiting_human_approval", "blocked"].includes(initialStatus)) throw fail("SPRINT_REGISTRY_INPUT", "A new sprint may only be planned, awaiting approval, or blocked.");
    for (const id of dependencies) {
      const dependency = get(id);
      if (!dependency || dependency.position >= position) throw fail("SPRINT_DEPENDENCY_INVALID", "Sprint dependency must exist earlier in project order.");
    }
    const now = clock();
    database.transaction(() => {
      for (const id of dependencies) {
        const dependency = get(id);
        if (!dependency || dependency.position >= position) throw fail("SPRINT_DEPENDENCY_INVALID", "Dependency was archived or rescheduled before registration.");
      }
      database.run("INSERT INTO sprint_registry(sprint_id,project_id,position,dependencies_json,status,plan_id,plan_revision,plan_path,plan_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [sprintId, projectId, position, JSON.stringify(dependencies), initialStatus, plan?.plan_id ?? null, plan?.revision ?? null, plan?.file_path ?? null, plan?.sha256 ?? null, now, now]);
    });
    return get(sprintId);
  }

  // Reads scheduling state only from SQLite.
  function get(sprintId, { includeArchived = false } = {}) {
    if (!SAFE_ID.test(sprintId ?? "")) throw fail("SPRINT_REGISTRY_INPUT", "A valid sprint ID is required.");
    if (!includeArchived && isArchived(sprintId)) return undefined;
    return project(database.all("SELECT * FROM sprint_registry WHERE project_id=? AND sprint_id=?", [projectId, sprintId])[0]);
  }

  // Resolves the canonical project sprint view from its registry record and bound immutable plan.
  async function getDetail(sprintId) {
    const sprint = get(sprintId);
    if (!sprint) return null;
    const plan = await readBoundPlan(sprint);
    if (!plan) return { id: sprint.sprint_id, project_id: sprint.project_id, dependencies: sprint.dependencies, status: sprint.status, version: sprint.version, order: sprint.position + 1, tickets: [], exit_criteria: [] };
    const ticketIds = structuredClone(plan.content.tickets);
    const tickets = structuredClone((plan.content.ticket_specs ?? []).filter((ticket) => ticketIds.includes(ticket.id)));
    return { id: sprint.sprint_id, project_id: sprint.project_id, roadmap_id: tickets[0]?.roadmap_id, human_plan: Object.fromEntries(["outcome", "in_scope", "out_of_scope", "approach", "components", "risks", "assumptions", "open_questions", "evidence_refs", "acceptance_criteria"].map((key) => [key, structuredClone(plan.content[key])])), objective: plan.content.objective, dependencies: sprint.dependencies, status: sprint.status, version: sprint.version, order: sprint.position + 1, ticket_ids: ticketIds, tickets, exit_criteria: structuredClone(plan.content.acceptance_criteria), plan_id: sprint.plan_id, plan_revision: sprint.plan_revision, plan_sha256: sprint.plan_sha256 };
  }

  // Lists sprints in their explicit execution order.
  function list({ includeArchived = false } = {}) { return database.all("SELECT * FROM sprint_registry WHERE project_id=? ORDER BY position", [projectId]).map(project).filter((record) => includeArchived || !isArchived(record.sprint_id)); }

  // Recognizes retained Sprint tombstones so legacy readers cannot resurrect archived scope.
  function isArchived(sprintId) { return database.all("SELECT sprint_id FROM sprint_registry_archives WHERE project_id=? AND sprint_id=?", [projectId, sprintId]).length > 0; }

  // Blocks replan/archive while any retained Ticket execution still owns this Sprint.
  function assertMutable(sprintId, expectedVersion) {
    const sprint = get(sprintId);
    if (!sprint) throw Object.assign(fail("SPRINT_NOT_FOUND", "Sprint is not active in Registry."), { statusCode: 404 });
    assertExpectedVersion(sprint, expectedVersion);
    if (["running", "done"].includes(sprint.status)) throw fail("SPRINT_MUTATION_ACTIVE", "Running or completed Sprint scope cannot be replanned or archived.");
    const hasStatus = database.all("SELECT name FROM sqlite_master WHERE type='table' AND name='ticket_status'").length;
    const states = hasStatus ? database.all("SELECT ticket_id,status,details_json FROM ticket_status WHERE project_id=?", [projectId]) : [];
    const hasTickets = database.all("SELECT name FROM sqlite_master WHERE type='table' AND name='tickets'").length;
    const legacyTickets = new Set(hasTickets ? database.all("SELECT id FROM tickets WHERE project_id=? AND sprint_id=?", [projectId, sprintId]).map((ticket) => ticket.id) : []);
    for (const state of states) {
      const details = JSON.parse(state.details_json ?? "{}");
      if ((details.execution_basis?.sprint_id === sprintId || legacyTickets.has(state.ticket_id)) && (details.launch_claim || details.execution_id && state.status !== "done" || ["running", "reviewing", "needs_human_review"].includes(state.status))) throw fail("SPRINT_EXECUTION_RECONCILIATION_REQUIRED", "Retained execution ownership must be reconciled before Sprint mutation.");
    }
    return sprint;
  }

  // Removes Sprint scheduling visibility without deleting plan revisions, decisions or execution history.
  function archive({ sprintId, expectedVersion } = {}) {
    return database.transaction(() => {
      const sprint = assertMutable(sprintId, expectedVersion);
      if (list().some((record) => record.sprint_id !== sprintId && record.dependencies.includes(sprintId))) throw fail("SPRINT_DEPENDENCY_IN_USE", "An active Sprint still depends on this Sprint.");
      database.run("INSERT INTO sprint_registry_archives(sprint_id,project_id,archived_at,record_json) VALUES (?,?,?,?)", [sprintId, projectId, clock(), JSON.stringify(sprint)]);
      database.run("UPDATE sprint_registry SET version=version+1,updated_at=? WHERE project_id=? AND sprint_id=? AND version=?", [clock(), projectId, sprintId, sprint.version]);
      return { deleted: true, archived: true, sprint_id: sprintId };
    });
  }

  // Builds the Registry-owned detail collection used by the public sprint list.
  async function listDetails() { return Promise.all(list().map(({ sprint_id: sprintId }) => getDetail(sprintId))); }

  // Rebinds a sprint after replanning; prior approval cannot authorize the new revision.
  async function bindPlan({ sprintId, planId, revision, expectedVersion } = {}) {
    const sprint = get(sprintId);
    if (!sprint) throw fail("SPRINT_NOT_FOUND", "Sprint is not registered.");
    assertExpectedVersion(sprint, expectedVersion);
    if (sprint.status === "running") throw fail("SPRINT_REPLAN_RUNNING", "A running sprint must stop before its execution basis changes.");
    const plan = await plans.getRevision({ planId, revision });
    if (plan.project_id !== projectId || plan.sprint_id !== sprintId) throw fail("SPRINT_PLAN_MISMATCH", "Plan revision is not assigned to this project sprint.");
    return updateCurrent(sprint, "plan_id=?,plan_revision=?,plan_path=?,plan_sha256=?,status='awaiting_human_approval'", [planId, revision, plan.file_path, plan.sha256]);
  }

  // Verifies the plan file, approval, and completed sprint dependencies.
  async function assertReady(sprintId, { expectedVersion } = {}) {
    const sprint = get(sprintId);
    if (!sprint) throw fail("SPRINT_NOT_FOUND", "Sprint is not registered.");
    assertExpectedVersion(sprint, expectedVersion);
    const plan = await plans.assertExecutable({ planId: sprint.plan_id, revision: sprint.plan_revision, sha256: sprint.plan_sha256 });
    if (plan.project_id !== projectId || plan.sprint_id !== sprintId || plan.file_path !== sprint.plan_path || plan.sha256 !== sprint.plan_sha256) throw fail("SPRINT_PLAN_MISMATCH", "Sprint execution basis differs from the approved index.");
    const current = get(sprintId);
    if (!current) throw fail("SPRINT_NOT_FOUND", "Sprint disappeared during readiness validation.");
    assertExpectedVersion(current, sprint.version);
    const unfinished = sprint.dependencies.filter((id) => get(id)?.status !== "done");
    if (unfinished.length) throw fail("SPRINT_DEPENDENCIES_NOT_READY", `Sprint dependencies are unfinished: ${unfinished.join(", ")}.`);
    if (!["ready", "running"].includes(sprint.status)) throw fail("SPRINT_NOT_READY", "Sprint has not been marked ready for execution.");
    return { sprint, plan };
  }

  // Changes lifecycle state without modifying the referenced immutable plan.
  async function setStatus({ sprintId, status, expectedVersion } = {}) {
    const sprint = get(sprintId);
    if (!sprint || !STATUSES.has(status)) throw fail("SPRINT_REGISTRY_INPUT", "Sprint and valid status are required.");
    assertExpectedVersion(sprint, expectedVersion);
    const transitions = { planned: ["ready", "awaiting_human_approval", "blocked"], awaiting_human_approval: ["ready", "blocked"], ready: ["running", "blocked"], running: ["done", "failed", "blocked"], failed: ["ready", "blocked"], blocked: ["ready"], done: [] };
    if (status !== sprint.status && !transitions[sprint.status]?.includes(status)) throw fail("SPRINT_STATUS_TRANSITION", "Sprint lifecycle transition is not allowed.");
    if (["ready", "running"].includes(status)) {
      if (!sprint.plan_id || !Number.isSafeInteger(sprint.plan_revision) || !sprint.plan_sha256) throw fail("PLAN_APPROVAL_REQUIRED", "A sprint needs an approved immutable plan before it can become ready.");
      const plan = await plans.assertExecutable({ planId: sprint.plan_id, revision: sprint.plan_revision, sha256: sprint.plan_sha256 });
      if (plan.file_path !== sprint.plan_path) throw fail("SPRINT_PLAN_MISMATCH", "Sprint plan path differs from the approved index.");
      if (sprint.dependencies.some((id) => get(id)?.status !== "done")) throw fail("SPRINT_DEPENDENCIES_NOT_READY", "Sprint dependencies are unfinished.");
    }
    if (status === "done") await plans.assertExecutable({ planId: sprint.plan_id, revision: sprint.plan_revision, sha256: sprint.plan_sha256 });
    return updateCurrent(sprint, "status=?", [status]);
  }

  // Rejects obsolete caller expectations before any plan validation or mutation.
  function assertExpectedVersion(sprint, expectedVersion = sprint.version) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion !== sprint.version) throw Object.assign(fail("SPRINT_REGISTRY_CONFLICT", "Sprint changed; reload its current scheduling record before continuing."), { retryable: false, scope: "scoped", identifiers: [sprint.sprint_id] });
  }

  // Atomically fences scheduling writes against intervening bind/status changes, including ABA races.
  function updateCurrent(sprint, assignments, parameters) {
    // Commits the guarded write and reads its result under the same SQLite transaction.
    const apply = () => {
      if (assignments.startsWith("plan_id=")) assertMutable(sprint.sprint_id, sprint.version);
      if (isArchived(sprint.sprint_id)) throw fail("SPRINT_ARCHIVED", "Archived Sprint cannot be mutated.");
      const result = database.run(`UPDATE sprint_registry SET ${assignments},version=version+1,updated_at=? WHERE sprint_id=? AND project_id=? AND version=?`, [...parameters, clock(), sprint.sprint_id, projectId, sprint.version]);
      if (Number(result.changes) !== 1) throw Object.assign(fail("SPRINT_REGISTRY_CONFLICT", "Sprint changed while its plan was being validated; reload before continuing."), { retryable: false, scope: "scoped", identifiers: [sprint.sprint_id] });
      return get(sprint.sprint_id);
    };
    return typeof database.transaction === "function" ? database.transaction(apply) : apply();
  }

  // Skips unscheduled plans without hiding a corrupt immutable execution basis.
  async function readBoundPlan(sprint) {
    const binding = [sprint.plan_id, sprint.plan_revision, sprint.plan_path, sprint.plan_sha256];
    if (binding.every((value) => value === null)) return null;
    if (!SAFE_ID.test(sprint.plan_id ?? "") || !Number.isSafeInteger(sprint.plan_revision) || sprint.plan_revision < 1 || typeof sprint.plan_path !== "string" || !sprint.plan_path || !/^[a-f0-9]{64}$/.test(sprint.plan_sha256 ?? "")) throw fail("SPRINT_PLAN_MISMATCH", "Sprint plan binding is incomplete or invalid.");
    const plan = await plans.getRevision({ planId: sprint.plan_id, revision: sprint.plan_revision });
    if (plan.project_id !== sprint.project_id || plan.sprint_id !== sprint.sprint_id || plan.file_path !== sprint.plan_path || plan.sha256 !== sprint.plan_sha256) throw fail("SPRINT_PLAN_MISMATCH", "Sprint plan identity differs from its registry binding.");
    return plan;
  }

  // Resolves a ticket only from the current registered sprint plan.
  async function getByTicket(ticketId) {
    for (const sprint of list()) {
      const plan = await readBoundPlan(sprint);
      if (plan?.content.tickets.includes(ticketId)) return sprint;
    }
    return null;
  }
}
