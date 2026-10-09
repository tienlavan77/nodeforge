// Verifies durable Ticket execution claims, stale-event fencing and immutable completion parity across RUN and DAG boundaries.
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
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";
import { createApprovedTicketDispatch } from "../../src/application/approved-ticket-dispatch.js";
import { createSprintDagRunner } from "../../src/modules/supervisor/sprint-dag.js";
import { waitForTicketExecution } from "../../src/modules/supervisor/sprint-execution-wait.js";
import { getRegistryDashboard } from "../../src/application/registry-dashboard.js";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";

const PROJECT = "PROJECT-A";
const TICKET = { id: "TICKET-A", project_id: PROJECT, sprint_id: "SPRINT-A", title: "Fence execution", objective: "Preserve current attempt", dependencies: [], acceptance_criteria: ["Old events cannot complete new work"] };
const CONTENT = { objective: TICKET.objective, outcome: "Exact completion", in_scope: "Execution", out_of_scope: "Migration", approach: "Persist attempt identity", components: ["Ticket"], tickets: [TICKET.id], ticket_specs: [TICKET], dependencies: [], risks: [], assumptions: [], open_questions: [], evidence_refs: [TICKET.id], acceptance_criteria: TICKET.acceptance_criteria };

// Controls asynchronous boundaries without sleep-based races.
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

// Creates actual SQLite, immutable approval and status history with an ordered test event bus.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ticket-execution-fence-"));
  const options = { dataDir: root, runtimeDir: "." };
  const database = await createDatabaseService(options);
  const plans = createHumanPlanStore({ projectId: PROJECT, database, fileService: createFileService({ projectRoot: root, allowPlanStorage: true }) });
  const registry = createSprintRegistry({ projectId: PROJECT, database, plans });
  const plan = await plans.createRevision({ planId: "PLAN-A", sprintId: TICKET.sprint_id, expectedRevision: 0, content: CONTENT });
  await plans.decide({ planId: plan.plan_id, revision: 1, sha256: plan.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
  await registry.register({ sprintId: TICKET.sprint_id, position: 0, planId: plan.plan_id, revision: 1 });
  const basis = await registry.setStatus({ sprintId: TICKET.sprint_id, status: "ready" });
  const store = createTicketStatusStore({ projectId: PROJECT, database });
  const handlers = new Set();
  const bus = { subscribe: (_scope, handler) => { handlers.add(handler); return () => handlers.delete(handler); }, publish: async (event) => { for (const handler of [...handlers]) await handler(event); } };
  return { root, options, database, plans, registry, basis, store, bus, handlers, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

// Claims the next explicit execution from the currently observed status version.
function begin(f, executionId = "RUN-A", fresh = false) { const current = f.store.get(TICKET.id) ?? f.store.create(TICKET.id); return f.store.beginExecution(TICKET.id, { executionId, basis: f.basis, expectedVersion: current.version, fresh }); }

// Builds the actual shared RUN service while exposing controlled submission and checkpoint boundaries.
function dispatch(f, execute, checkpoints = {}, clears = []) { return createTicketRunDispatch({ disposition: { get: async () => null }, intake: { open: async () => ({ ticket: TICKET }) }, sprintRegistry: f.registry, ticketStatusStore: f.store, checkpoints: { load: async () => null, clear: async () => clears.push("checkpoint"), ...checkpoints }, protocolStorage: { clearTask: async () => clears.push("protocol") }, conversationStateStore: { clear: async () => clears.push("conversation") }, dispatchTask: execute }); }

// Produces the same scoped identity carried by production terminal outcomes.
function outcome(f, type = "task.completed", executionId = "RUN-A", basis = f.basis, projectId = PROJECT) { return { type, project_id: projectId, task_id: TICKET.id, request_id: "REQ-SAME", correlation_id: "CORR-SAME", payload: { execution_id: executionId, execution_basis: basis } }; }

test("durable claim has one winner and reopening SQLite cannot replace a running attempt", async () => {
  const f = await fixture(); const other = await createDatabaseService(f.options);
  try {
    f.store.create(TICKET.id);
    const second = createTicketStatusStore({ projectId: PROJECT, database: other });
    const observed = second.get(TICKET.id);
    begin(f);
    assert.throws(() => second.beginExecution(TICKET.id, { executionId: "RUN-B", basis: f.basis, expectedVersion: observed.version }), { code: "STATUS_CONFLICT" });
    assert.throws(() => second.beginExecution(TICKET.id, { executionId: "RUN-B", basis: f.basis, expectedVersion: second.get(TICKET.id).version }), { code: "STATUS_EXECUTION_ACTIVE", retryable: false });
    f.store.updateStatus(TICKET.id, "reviewing", { reason: "review_started" });
    assert.equal(second.get(TICKET.id).details.execution_id, "RUN-A");
    assert.throws(() => second.updateStatus(TICKET.id, "done", {}, { expectedExecutionId: "RUN-B" }), { code: "STATUS_CONFLICT" });
  } finally { await other.close(); await f.close(); }
});

test("terminal bridge rejects old/foreign/tampered identity and deduplicates through durable status after reconnect", async () => {
  const f = await fixture(); const updates = []; const logs = [];
  let bridge = createTerminalBridge({ eventBus: f.bus, ticketStatusStore: f.store, roadmaps: { updateTicketStatus: (input) => updates.push(input) }, projectId: PROJECT, logger: (entry) => logs.push(entry) });
  try {
    begin(f);
    for (const event of [outcome(f, "task.completed", "RUN-OLD"), outcome(f, "task.completed", "RUN-A", f.basis, "PROJECT-B"), outcome(f, "task.completed", "RUN-A", { ...f.basis, plan_sha256: "0".repeat(64) }), outcome(f, "task.completed", "RUN-A", { ...f.basis, version: f.basis.version + 1 })]) await f.bus.publish(event);
    assert.equal(f.store.getStatus(TICKET.id), "running");
    await f.bus.publish(outcome(f));
    assert.equal(f.store.getStatus(TICKET.id), "done");
    bridge.close();
    bridge = createTerminalBridge({ eventBus: f.bus, ticketStatusStore: f.store, roadmaps: { updateTicketStatus: (input) => updates.push(input) }, projectId: PROJECT });
    await f.bus.publish(outcome(f)); await f.bus.publish(outcome(f, "task.failed"));
    assert.equal(updates.length, 1);
    assert.equal(f.store.getHistory(TICKET.id).length, 2);
    assert.equal(logs.filter((entry) => entry.event_name === "terminal_bridge.stale_execution").length, 4);
  } finally { bridge.close(); await f.close(); }
});

test("guarded terminal CAS conflict never reloads old intent onto a new execution", async () => {
  const f = await fixture(); const updates = [];
  const store = { ...f.store, updateStatus: (ticketId, status, details, options) => {
    f.store.updateStatus(ticketId, "failed", { reason: "explicit_recovery" });
    begin(f, "RUN-B");
    return f.store.updateStatus(ticketId, status, details, options);
  } };
  const bridge = createTerminalBridge({ eventBus: f.bus, ticketStatusStore: store, roadmaps: { updateTicketStatus: (input) => updates.push(input) }, projectId: PROJECT });
  try {
    begin(f); await f.bus.publish(outcome(f));
    assert.equal(f.store.getStatus(TICKET.id), "running"); assert.equal(f.store.get(TICKET.id).details.execution_id, "RUN-B"); assert.deepEqual(updates, []);
  } finally { bridge.close(); await f.close(); }
});

test("old dispatch failure cannot mark a newer durable execution failed", { timeout: 5000 }, async () => {
  const f = await fixture(); const first = deferred(); const second = deferred(); const enteredFirst = deferred(); const enteredSecond = deferred();
  try {
    const old = dispatch(f, async (request) => { enteredFirst.resolve(request); return first.promise; })({ projectId: PROJECT, ticketId: TICKET.id });
    const oldRequest = await enteredFirst.promise;
    f.store.updateStatus(TICKET.id, "failed", { reason: "explicit_recovery" }, { expectedExecutionId: oldRequest.executionId });
    const next = dispatch(f, async (request) => { enteredSecond.resolve(request); return second.promise; })({ projectId: PROJECT, ticketId: TICKET.id });
    await enteredSecond.promise;
    const winner = f.store.get(TICKET.id);
    first.reject(new Error("Old submission failed"));
    await assert.rejects(old, /Old submission failed/);
    assert.deepEqual(f.store.get(TICKET.id), winner);
    second.resolve({ status: "accepted" }); await next;
  } finally { first.resolve({ status: "accepted" }); second.resolve({ status: "accepted" }); await f.close(); }
});

test("stale readiness after checkpoint rejects before claim, clears or submission", { timeout: 5000 }, async () => {
  const f = await fixture(); const entered = deferred(); const resume = deferred(); const clears = []; let submissions = 0;
  try {
    const pending = dispatch(f, async () => { submissions += 1; }, { load: async () => { entered.resolve(); await resume.promise; return null; } }, clears)({ projectId: PROJECT, ticketId: TICKET.id });
    await entered.promise;
    await f.registry.bindPlan({ sprintId: TICKET.sprint_id, planId: "PLAN-A", revision: 1 });
    await f.registry.setStatus({ sprintId: TICKET.sprint_id, status: "ready" });
    resume.resolve(); await assert.rejects(pending, { code: "SPRINT_REGISTRY_CONFLICT" });
    assert.deepEqual(clears, []); assert.equal(submissions, 0); assert.equal(f.store.get(TICKET.id), undefined);
  } finally { resume.resolve(); await f.close(); }
});

test("production pre-submit boundary requires ownership and carries durable identity", async () => {
  const f = await fixture(); const submitted = [];
  try {
    begin(f);
    const production = createApprovedTicketDispatch({ projectId: PROJECT, sprintRegistry: f.registry, ticketStatusStore: f.store, integration: { submitTicket: async (request) => { submitted.push(request); return { status: "accepted" }; } } });
    await assert.rejects(production({ ticket: TICKET, sprintBasis: f.basis, executionId: "RUN-OLD" }), { code: "TICKET_EXECUTION_CONFLICT" });
    await production({ ticket: TICKET, sprintBasis: f.basis, executionId: "RUN-A" });
    assert.equal(submitted[0].payload.execution_id, "RUN-A");
  } finally { await f.close(); }
});

test("attempt wait ignores wrong events and reads committed completion before/after subscription", { timeout: 5000 }, async () => {
  const f = await fixture(); const bridge = createTerminalBridge({ eventBus: f.bus, ticketStatusStore: f.store, roadmaps: { updateTicketStatus: () => {} }, projectId: PROJECT });
  try {
    begin(f); let finished = false;
    const pending = waitForTicketExecution({ ticketId: TICKET.id, projectId: PROJECT, basis: f.basis, executionId: "RUN-A", ticketStatusStore: f.store, eventBus: f.bus }).then(() => { finished = true; });
    await f.bus.publish(outcome(f, "task.completed", "RUN-OLD")); assert.equal(finished, false);
    await f.bus.publish(outcome(f)); await pending; assert.equal(finished, true);
    await waitForTicketExecution({ ticketId: TICKET.id, projectId: PROJECT, basis: f.basis, executionId: "RUN-A", ticketStatusStore: f.store, eventBus: f.bus });
    assert.equal(f.handlers.size, 1);
  } finally { bridge.close(); await f.close(); }
});

test("replan same Ticket ID cannot reuse old done evidence in RUN, DAG or dashboard", async () => {
  const f = await fixture();
  try {
    begin(f); f.store.updateStatus(TICKET.id, "done");
    const revised = await f.plans.createRevision({ planId: "PLAN-A", sprintId: TICKET.sprint_id, expectedRevision: 1, content: { ...CONTENT, approach: "Revised approved scope" } });
    await f.plans.decide({ planId: "PLAN-A", revision: 2, sha256: revised.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
    await f.registry.bindPlan({ sprintId: TICKET.sprint_id, planId: "PLAN-A", revision: 2 });
    const basis = await f.registry.setStatus({ sprintId: TICKET.sprint_id, status: "ready" });
    const runner = createSprintDagRunner({ ticketStatusStore: f.store, eventBus: f.bus, dispatchTask: async () => { throw new Error("Must not dispatch stale done"); } });
    await assert.rejects(runner.runSprintLevels({ projectId: PROJECT, sprintId: TICKET.sprint_id, levels: [[TICKET]], sprintBasis: basis }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
    await assert.rejects(dispatch(f, async () => ({}))({ projectId: PROJECT, ticketId: TICKET.id }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
    const dashboard = await getRegistryDashboard({ projectId: PROJECT, sprintRegistry: f.registry, ticketStatusStore: f.store });
    assert.equal(dashboard.roadmap.sprints[0].tasks[0].status, "untracked"); assert.equal(dashboard.roadmap.sprints[0].tasks[0].progress, 0);
  } finally { await f.close(); }
});

test("actual DAG consumes persisted attempt completion rather than the event type", async () => {
  const f = await fixture(); const bridge = createTerminalBridge({ eventBus: f.bus, ticketStatusStore: f.store, roadmaps: { updateTicketStatus: () => {} }, projectId: PROJECT });
  try {
    const runner = createSprintDagRunner({ ticketStatusStore: f.store, eventBus: f.bus, dispatchTask: async () => { begin(f); await f.bus.publish(outcome(f)); return { status: "completed", execution_id: "RUN-A" }; } });
    const results = await runner.runSprintLevels({ projectId: PROJECT, sprintId: TICKET.sprint_id, levels: [[TICKET]], sprintBasis: f.basis });
    assert.equal(results[0].result.execution_id, "RUN-A");
  } finally { bridge.close(); await f.close(); }
});

test("actual integration failure producer preserves Project, execution ID and basis", async () => {
  const events = []; const profile = { agent_id: "claude-coder", role: "coder", provider: "claude", enabled: true, status: "ready" };
  const basis = { project_id: PROJECT, sprint_id: TICKET.sprint_id, plan_id: "PLAN-A", plan_revision: 1, plan_path: "plan.json", plan_sha256: "a".repeat(64), version: 1 };
  const integration = createNodeforgeTaskIntegration({ projectRoot: process.cwd(), supervisorManager: { startTask: async () => ({}) }, eventBus: { publish: async (event) => events.push(event) }, agentResolver: { list: () => [profile], resolveAvailable: () => profile }, agentOccupancy: { getByTask: () => null, claim: async () => ({ claim_id: "CLAIM-A" }), release: async () => {} }, handoffQueue: { enqueue: async () => ({ id: "JOB-A" }) }, claudeSdkGateway: { execute: async () => { throw Object.assign(new Error("Provider failed"), { code: "PROVIDER_FAILED" }); } }, runtimeGovernance: { createExecutionContext: (input) => input } });
  await assert.rejects(integration.submitTicket({ ticket: TICKET, project_id: PROJECT, required_role: "coder", payload: { execution_id: "RUN-A", sprint_basis: basis } }));
  const event = events.find((entry) => entry.type === "task.failed");
  assert.equal(event.project_id, PROJECT); assert.equal(event.payload.execution_id, "RUN-A"); assert.deepEqual(event.payload.execution_basis, basis);
});
