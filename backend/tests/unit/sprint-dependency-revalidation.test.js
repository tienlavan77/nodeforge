// Verifies that Sprint dependency completion remains current after waits and asynchronous Registry lookups.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";
import { createTerminalBridge } from "../../src/modules/supervisor/terminal-bridge.js";
import { runFencedSprintLevels } from "../../src/modules/supervisor/sprint-execution-wait.js";

const PROJECT = "PROJECT-A";

// Pauses dependency resolution at a deterministic boundary without timers or sleep.
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }

// Builds real approved plans, Registry scheduling records and persisted dependency attempts.
async function fixture({ waiting = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sprint-dependency-revalidation-"));
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  const plans = createHumanPlanStore({ projectId: PROJECT, database, fileService: createFileService({ projectRoot: root, allowPlanStorage: true }) });
  const registry = createSprintRegistry({ projectId: PROJECT, database, plans });
  const store = createTicketStatusStore({ projectId: PROJECT, database });
  const bases = {}; const contents = {};
  for (const id of ["A", "B", "TARGET"]) {
    const ticket = { id: `TICKET-${id}`, project_id: PROJECT, sprint_id: `SPRINT-${id}`, title: "Dependency gate", objective: "Only use current completion", dependencies: [], acceptance_criteria: ["No stale dispatch"] };
    const content = { objective: ticket.objective, outcome: "Current dependency", in_scope: "Sprint execution", out_of_scope: "Migration", approach: "Check committed identity", components: ["DAG"], tickets: [ticket.id], ticket_specs: [ticket], dependencies: [], risks: [], assumptions: [], open_questions: [], evidence_refs: [ticket.id], acceptance_criteria: ticket.acceptance_criteria };
    contents[id] = content;
    const plan = await plans.createRevision({ planId: `PLAN-${id}`, sprintId: ticket.sprint_id, expectedRevision: 0, content });
    await plans.decide({ planId: plan.plan_id, revision: 1, sha256: plan.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
    await registry.register({ sprintId: ticket.sprint_id, position: Object.keys(bases).length, planId: plan.plan_id, revision: 1 });
    bases[id] = await registry.setStatus({ sprintId: ticket.sprint_id, status: "ready" });
    if (id !== "TARGET") {
      const current = store.create(ticket.id);
      store.beginExecution(ticket.id, { executionId: `RUN-${id}`, basis: bases[id], expectedVersion: current.version });
      if (!waiting || id !== "A") store.updateStatus(ticket.id, "done");
    }
  }
  const handlers = new Set(); const subscribed = deferred();
  const bus = { subscribe: (_scope, handler) => { handlers.add(handler); if (handlers.size > 1) subscribed.resolve(); return () => handlers.delete(handler); }, publish: async (event) => { for (const handler of [...handlers]) await handler(event); } };
  const bridge = createTerminalBridge({ eventBus: bus, ticketStatusStore: store, roadmaps: { updateTicketStatus: () => {} }, projectId: PROJECT });
  const dispatched = [];
  // Runs the real fenced DAG and records whether its dependent Ticket was submitted.
  const run = (sprintRegistry = registry, dependencies = ["TICKET-A"]) => runFencedSprintLevels({ projectId: PROJECT, levels: [[{ id: "TICKET-TARGET", dependencies }]], sprintBasis: bases.TARGET, ticketStatusStore: store, eventBus: bus, sprintRegistry, dispatchTask: async ({ ticket }) => {
    dispatched.push(ticket.id);
    const current = store.create(ticket.id);
    store.beginExecution(ticket.id, { executionId: "RUN-TARGET", basis: bases.TARGET, expectedVersion: current.version });
    store.updateStatus(ticket.id, "done");
    return { execution_id: "RUN-TARGET" };
  } });
  // Rebinds the dependency to a genuine newly approved immutable revision while preserving its Ticket ID.
  const rebind = async () => {
    const plan = await plans.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 1, content: { ...contents.A, approach: "Revised dependency work" } });
    await plans.decide({ planId: plan.plan_id, revision: 2, sha256: plan.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
    await registry.bindPlan({ sprintId: "SPRINT-A", planId: "PLAN-A", revision: 2 });
    await registry.setStatus({ sprintId: "SPRINT-A", status: "ready" });
  };
  // Publishes the exact old attempt's terminal event through the real terminal bridge.
  const complete = () => bus.publish({ type: "task.completed", project_id: PROJECT, task_id: "TICKET-A", request_id: "REQUEST-A", correlation_id: "CORR-A", payload: { execution_id: "RUN-A", execution_basis: bases.A } });
  return { registry, store, bases, bus, subscribed, run, rebind, complete, dispatched, close: async () => { bridge.close(); await database.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const change of ["rebind", "block"]) {
  test(`dependency ${change} while waiting prevents dependent dispatch`, { timeout: 5000 }, async () => {
    const f = await fixture({ waiting: true });
    try {
      const running = f.run();
      const rejected = assert.rejects(running, { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", retryable: false });
      await f.subscribed.promise;
      if (change === "rebind") await f.rebind();
      else await f.registry.setStatus({ sprintId: "SPRINT-A", status: "blocked" });
      await f.complete(); await rejected;
      assert.deepEqual(f.dispatched, []);
    } finally { await f.close(); }
  });
}

test("later asynchronous dependency lookup cannot hide a scheduling ABA in an earlier dependency", async () => {
  const f = await fixture(); let lookups = 0;
  try {
    const registry = { ...f.registry, getByTicket: async (id) => {
      const result = await f.registry.getByTicket(id);
      if (++lookups === 4) {
        await f.registry.setStatus({ sprintId: "SPRINT-A", status: "blocked" });
        await f.registry.setStatus({ sprintId: "SPRINT-A", status: "ready" });
      }
      return result;
    } };
    await assert.rejects(f.run(registry, ["TICKET-A", "TICKET-B"]), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
    assert.deepEqual(f.dispatched, []);
  } finally { await f.close(); }
});

test("replacement dependency attempt during resolution is not silently substituted for observed completion", async () => {
  const f = await fixture(); let lookups = 0;
  try {
    const registry = { ...f.registry, getByTicket: async (id) => {
      const result = await f.registry.getByTicket(id);
      if (++lookups === 2) {
        f.store.beginExecution(id, { executionId: "RUN-NEW", basis: f.bases.A, expectedVersion: f.store.get(id).version, fresh: true });
        f.store.updateStatus(id, "done");
      }
      return result;
    } };
    await assert.rejects(f.run(registry), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
    assert.deepEqual(f.dispatched, []);
  } finally { await f.close(); }
});

test("same immutable dependency completing its Sprint can still open the dependent Ticket", { timeout: 5000 }, async () => {
  const f = await fixture({ waiting: true });
  try {
    const running = f.run(); await f.subscribed.promise;
    await f.registry.setStatus({ sprintId: "SPRINT-A", status: "running" });
    await f.registry.setStatus({ sprintId: "SPRINT-A", status: "done" });
    await f.complete(); await running;
    assert.deepEqual(f.dispatched, ["TICKET-TARGET"]);
  } finally { await f.close(); }
});

test("foreign Project dependency basis is rejected before waiting or dispatch", async () => {
  const f = await fixture();
  try {
    const registry = { ...f.registry, getByTicket: async () => ({ ...f.bases.A, project_id: "PROJECT-B" }) };
    await assert.rejects(f.run(registry), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
    assert.deepEqual(f.dispatched, []);
  } finally { await f.close(); }
});
