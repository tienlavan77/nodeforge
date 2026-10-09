// Verifies original dependency intent survives the real DAG, shared RUN, approved submission and file-backed enqueue path.
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
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";
import { createApprovedTicketDispatch } from "../../src/application/approved-ticket-dispatch.js";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";
import { createDurableQueue } from "../../src/modules/supervisor/durable-queue.js";
import { createFileQueueStore } from "../../src/modules/supervisor/file-queue-store.js";
import { runFencedSprintLevels } from "../../src/modules/supervisor/sprint-execution-wait.js";
import { assertDependencyExpectations, assertDependencySubmission } from "../../src/modules/supervisor/ticket-dependency-expectations.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";
import { createRuntimeToolGovernance } from "../../src/modules/governance/runtime-tool-governance.js";

const PROJECT = "PROJECT-A";

// Verifies unresolved launches expose a non-retryable conflict without losing the provider's original error.
function assertUnknownOutcome(error) {
  assert.equal(error.code, "TICKET_EXECUTION_RECONCILIATION_REQUIRED");
  assert.equal(error.statusCode, 409);
  assert.equal(error.retryable, false);
  assert.equal(error.scope, "scoped");
  assert.deepEqual(error.identifiers, ["TICKET-TARGET"]);
  assert.ok(error.cause instanceof Error);
  assert.equal(error.cause.code, "PROVIDER_OBSERVED");
  assert.equal(error.cause.message, "Provider boundary observed");
  return true;
}

// Pauses real submission boundaries without timing-based races.
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }

// Creates approved plans and persistent status/queue evidence while isolating provider and occupancy timing.
async function fixture({ stage, local = false, multiple = false, rejectLaunch = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ticket-dependency-submission-"));
  const options = { dataDir: root, runtimeDir: "." };
  const database = await createDatabaseService(options);
  const files = createFileService({ projectRoot: root, allowPlanStorage: true });
  const plans = createHumanPlanStore({ projectId: PROJECT, database, fileService: files });
  const registry = createSprintRegistry({ projectId: PROJECT, database, plans });
  const store = createTicketStatusStore({ projectId: PROJECT, database });
  const bases = {}; const tickets = {}; const contents = {};
  for (const ids of local ? [["A", "TARGET"], ["B"]] : [["A"], ["B"], ["TARGET"]]) {
    const id = ids.at(-1);
    const specs = ids.map((item) => ({ id: `TICKET-${item}`, project_id: PROJECT, sprint_id: `SPRINT-${id}`, title: "Current dependency", objective: "Preserve original dependency execution", dependencies: item === "TARGET" ? multiple ? ["TICKET-A", "TICKET-B"] : ["TICKET-A"] : [], acceptance_criteria: ["Do not launch stale intent"] }));
    const content = { objective: specs[0].objective, outcome: "Fenced submission", in_scope: "Execution", out_of_scope: "Migration", approach: "Carry exact dependency set", components: ["RUN"], tickets: specs.map((ticket) => ticket.id), ticket_specs: specs, dependencies: [], risks: [], assumptions: [], open_questions: [], evidence_refs: [specs[0].id], acceptance_criteria: specs[0].acceptance_criteria };
    contents[id] = content;
    const plan = await plans.createRevision({ planId: `PLAN-${id}`, sprintId: `SPRINT-${id}`, expectedRevision: 0, content });
    await plans.decide({ planId: plan.plan_id, revision: 1, sha256: plan.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
    await registry.register({ sprintId: `SPRINT-${id}`, position: Object.keys(contents).length, planId: plan.plan_id, revision: 1 });
    const basis = await registry.setStatus({ sprintId: `SPRINT-${id}`, status: "ready" });
    for (const spec of specs) { tickets[spec.id] = spec; bases[spec.id] = basis; }
  }
  for (const id of ["A", "B"]) {
    const ticketId = `TICKET-${id}`; const current = store.create(ticketId);
    store.beginExecution(ticketId, { executionId: `RUN-${id}`, basis: bases[ticketId], expectedVersion: current.version });
    store.updateStatus(ticketId, "done");
  }
  const entered = deferred(); const proceed = deferred(); const clears = []; const launched = []; const releases = []; const logs = []; const outcomes = [];
  // Controls only the nominated preparation/save boundary; provider execution is never a production agent.
  const pause = async (name) => { if (stage === name) { entered.resolve(); await proceed.promise; } };
  const queueStore = createFileQueueStore({ fileService: files });
  const queue = createDurableQueue({ name: "sender.handoff", store: { ...queueStore, save: async (name, item) => { await pause("queue-save"); return queueStore.save(name, item); } } });
  const profile = { agent_id: "claude-coder", role: "coder", provider: "claude", enabled: true, status: "ready" };
  const runtimeGovernance = createRuntimeToolGovernance({ database });
  const toolRegistry = createForgeToolRegistry({ projectRoot: root, fileService: files, protocolStorage: { get: async () => null }, governance: runtimeGovernance });
  assert.equal(typeof toolRegistry.read_file?.execute, "function");
  const integration = createNodeforgeTaskIntegration({ projectRoot: root, supervisorManager: { startTask: async () => ({}) }, eventBus: { publish: async (event) => outcomes.push(event) }, agentResolver: { list: () => [profile], resolveAvailable: () => profile }, agentOccupancy: { getByTask: () => null, claim: async () => { await pause("occupancy"); return { claim_id: "CLAIM-A" }; }, release: async (input) => releases.push(input) }, ticketStatusStore: rejectLaunch ? { ...store, claimExecutionLaunch: () => { throw Object.assign(new Error("Controlled launch claim rejection"), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", retryable: false, launch_claim_conflict: true }); } } : store, sprintRegistry: registry, handoffQueue: queue, projectLogger: (entry) => logs.push(entry), resolveTicketWorkspace: async () => { await pause("workspace"); return null; }, claudeSdkGateway: { execute: async (request) => { assert.ok(request.options?.mcpServers?.forge); assert.ok(request.options?.allowedTools?.includes("mcp__forge__read_file")); const receipt = store.get("TICKET-TARGET").details.launch_claim; assert.equal(receipt?.state, "launch_claimed"); assert.equal(receipt.agent_id, profile.agent_id); assert.equal(receipt.dependency_expectations[0].execution_id, "RUN-A"); launched.push(request); throw Object.assign(new Error("Provider boundary observed"), { code: "PROVIDER_OBSERVED" }); } }, toolRegistry, runtimeGovernance });
  const approved = createApprovedTicketDispatch({ projectId: PROJECT, sprintRegistry: registry, ticketStatusStore: store, integration });
  const dispatch = createTicketRunDispatch({ disposition: { get: async () => null }, intake: { open: async ({ ticketId }) => ({ ticket: tickets[ticketId] }) }, sprintRegistry: registry, ticketStatusStore: store, checkpoints: { load: async () => { await pause("checkpoint"); return null; }, clear: async () => clears.push("checkpoint") }, protocolStorage: { clearTask: async () => clears.push("protocol") }, conversationStateStore: { clear: async () => clears.push("conversation") }, dispatchTask: approved });
  // Matches the production DAG-to-shared-RUN adapter, including its additive expectation argument.
  const run = () => runFencedSprintLevels({ projectId: PROJECT, levels: local ? [[tickets["TICKET-A"]], [tickets["TICKET-TARGET"]]] : [[tickets["TICKET-TARGET"]]], sprintBasis: bases["TICKET-TARGET"], ticketStatusStore: store, eventBus: { subscribe: () => () => {} }, sprintRegistry: registry, dispatchTask: ({ ticket, sprintBasis, dependencyExpectations }) => dispatch({ projectId: ticket.project_id, ticketId: ticket.id, expectedSprintVersion: sprintBasis.version, dependencyExpectations }) });
  // Produces a genuine newly approved dependency revision with the same Ticket identity.
  const rebind = async () => {
    const plan = await plans.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 1, content: { ...contents.A, approach: "Revised dependency" } });
    await plans.decide({ planId: "PLAN-A", revision: 2, sha256: plan.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
    await registry.bindPlan({ sprintId: "SPRINT-A", planId: "PLAN-A", revision: 2 });
    await registry.setStatus({ sprintId: "SPRINT-A", status: "ready" });
  };
  return { database, options, registry, store, bases, tickets, entered, proceed, clears, launched, releases, logs, outcomes, run, rebind, queueStore, queue, close: async () => { proceed.resolve(); await database.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const [stage, change] of [["checkpoint", "rebind"], ["workspace", "block"], ["occupancy", "replacement"], ["queue-save", "rebind"]]) {
  test(`original dependency ${change} during ${stage} prevents inline launch`, { timeout: 10000 }, async () => {
    const f = await fixture({ stage });
    try {
      const pending = f.run(); const rejected = assert.rejects(pending, { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", retryable: false });
      await Promise.race([f.entered.promise, pending.then(() => { throw new Error("Submission completed before the nominated boundary"); }, (error) => { throw error; })]);
      if (change === "rebind") await f.rebind();
      else if (change === "block") await f.registry.setStatus({ sprintId: "SPRINT-A", status: "blocked" });
      else {
        f.store.beginExecution("TICKET-A", { executionId: "RUN-NEW", basis: f.bases["TICKET-A"], expectedVersion: f.store.get("TICKET-A").version, fresh: true });
        f.store.updateStatus("TICKET-A", "done");
      }
      f.proceed.resolve(); await rejected;
      assert.deepEqual(f.launched, []);
      const jobs = await f.queueStore.list("sender.handoff");
      assert.equal(jobs.length, stage === "queue-save" ? 1 : 0);
      if (stage === "checkpoint") { assert.deepEqual(f.clears, []); assert.equal(f.store.get("TICKET-TARGET"), undefined); }
      if (stage === "occupancy") assert.equal(f.releases[0].reason, "handoff_failed");
      if (stage === "queue-save") {
        assert.equal(jobs[0].payload.dependency_expectations[0].execution_id, "RUN-A");
        assert.equal(jobs[0].status, "dead_letter");
        assert.equal(jobs[0].reconciliation_required, true);
        assert.equal(f.store.get("TICKET-TARGET").details.launch_claim, undefined);
        assert.deepEqual(await f.queue.recover(), []);
        assert.equal(await f.queue.claim("restart-worker"), null);
      }
    } finally { await f.close(); }
  });
}

test("rejected launch ownership records only intent, never a dispatch or provider-start witness", async () => {
  const f = await fixture({ rejectLaunch: true });
  try {
    await assert.rejects(f.run(), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
    assert.deepEqual(f.launched, []);
    assert.ok(f.logs.some((entry) => entry.event_name === "supervisor.agent_launch_intent"));
    assert.equal(f.logs.some((entry) => ["supervisor.agent_dispatch_boundary", "supervisor.agent_execution_started", "supervisor.agent_execution_completed"].includes(entry.event_name)), false);
  } finally { await f.close(); }
});

for (const local of [false, true]) {
  test(`exact ${local ? "local and external" : "multiple external"} dependency intent persists through claim and file queue`, async () => {
    const f = await fixture({ local, multiple: true });
    try {
      await assert.rejects(f.run(), assertUnknownOutcome);
      assert.equal(f.launched.length, 1);
      assert.equal(f.logs.some((entry) => entry.event_name === "supervisor.agent_execution_started"), false);
      const intent = f.logs.findIndex((entry) => entry.event_name === "supervisor.agent_launch_intent");
      const boundary = f.logs.findIndex((entry) => entry.event_name === "supervisor.agent_dispatch_boundary");
      assert.ok(intent >= 0 && boundary > intent);
      assert.equal(f.logs[boundary].payload.launch_claimed, true);
      assert.equal(f.logs[boundary].payload.provider_acknowledged, false);
      const jobs = await f.queueStore.list("sender.handoff");
      const expected = jobs[0].payload.dependency_expectations;
      assert.deepEqual(expected.map((entry) => entry.execution_id), ["RUN-A", "RUN-B"]);
      assert.deepEqual(f.store.get("TICKET-TARGET").details.dependency_expectations, expected);
      const other = await createDatabaseService(f.options);
      try { assert.deepEqual(createTicketStatusStore({ projectId: PROJECT, database: other }).get("TICKET-TARGET").details.dependency_expectations, expected); }
      finally { await other.close(); }
      assert.equal(f.store.getHistory("TICKET-TARGET")[0].details.dependency_expectations[0].execution_id, "RUN-A");
    } finally { await f.close(); }
  });
}

// Keeps unresolved provider launches owned and quarantined instead of reporting a retryable failure.
test("unknown claimed provider outcome retains occupancy and suppresses generic failure side effects", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run(), assertUnknownOutcome);
    assert.equal(f.launched.length, 1);
    assert.deepEqual(f.releases, []);
    assert.deepEqual(f.outcomes, []);
    const [job] = await f.queueStore.list("sender.handoff");
    const receipt = f.store.get("TICKET-TARGET").details.launch_claim;
    assert.equal(job.status, "dead_letter");
    assert.equal(job.reconciliation_required, true);
    assert.equal(job.failure_reason, "PROVIDER_OBSERVED");
    assert.equal(receipt.job_id, job.id);
    assert.equal(receipt.execution_id, job.payload.execution_id);
    assert.equal(receipt.state, "launch_claimed");
    const unknown = f.logs.find((entry) => entry.event_name === "supervisor.agent_outcome_unknown");
    assert.equal(unknown.payload.execution_id, receipt.execution_id);
    assert.equal(unknown.payload.cause_code, "PROVIDER_OBSERVED");
    assert.equal(await f.queue.claim("replacement-worker"), null);
    f.store.retry("TICKET-TARGET");
    await assert.rejects(f.run(), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", retryable: false });
    assert.equal(f.launched.length, 1);
    assert.deepEqual(f.releases, []);
  } finally { await f.close(); }
});

test("same-plan Sprint completion captures a new scheduling expectation without replacing completion identity", async () => {
  const f = await fixture();
  try {
    await f.registry.setStatus({ sprintId: "SPRINT-A", status: "running" });
    await f.registry.setStatus({ sprintId: "SPRINT-A", status: "done" });
    await assert.rejects(f.run(), assertUnknownOutcome);
    const expected = (await f.queueStore.list("sender.handoff"))[0].payload.dependency_expectations[0];
    assert.equal(expected.sprint_basis.version, f.registry.get("SPRINT-A").version);
    assert.equal(expected.execution_basis.version, f.bases["TICKET-A"].version);
    assert.equal(expected.execution_id, "RUN-A");
    assert.equal(f.launched.length, 1);
  } finally { await f.close(); }
});

test("claimed dependency intent rejects omissions and payload substitution without refreshing expectations", async () => {
  const f = await fixture({ multiple: true });
  try {
    await assert.rejects(f.run(), assertUnknownOutcome);
    const payload = (await f.queueStore.list("sender.handoff"))[0].payload;
    const target = f.tickets["TICKET-TARGET"];
    assert.throws(() => assertDependencyExpectations({ projectId: PROJECT, ticket: target, expectations: payload.dependency_expectations.slice(0, 1), sprintRegistry: f.registry, ticketStatusStore: f.store }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
    f.store.retry(target.id);
    const row = f.store.get(target.id);
    assert.throws(() => f.store.beginExecution(target.id, { executionId: "RUN-RESUME", basis: f.bases[target.id], expectedVersion: row.version, dependencyExpectations: payload.dependency_expectations }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", retryable: false });
    assert.equal(f.store.get(target.id).details.execution_id, payload.execution_id);
    await assert.rejects(f.run(), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", retryable: false });
    assert.equal(f.launched.length, 1);
    const changed = structuredClone(payload);
    changed.execution_id = "RUN-RESUME";
    changed.dependency_expectations.reverse();
    assert.throws(() => assertDependencySubmission({ projectId: PROJECT, ticket: target, payload: changed, sprintRegistry: f.registry, ticketStatusStore: f.store }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
  } finally { await f.close(); }
});
