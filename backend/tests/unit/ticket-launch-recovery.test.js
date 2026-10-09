// Verifies restart ownership retention, Registry submission boundaries and source identities for unknown provider outcomes.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeDispatchStorage, openDispatchStorage, PROJECT, TICKET } from "../fixtures/ticket-dispatch-recovery-fixture.mjs";
import { createProductionSupervisorRuntime } from "../../src/modules/supervisor/production-runtime.js";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";
import { assertDependencySubmission, captureDependencyExpectations } from "../../src/modules/supervisor/ticket-dependency-expectations.js";

const SOURCE_IDENTITIES = Object.freeze({
  "modules/supervisor/production-runtime.js": "bf8af53b00e8455c860c9ae5a8304241676b758e26f7f1246d87c77cc6fb720e",
  "modules/supervisor/ticket-launch-recovery.js": "be74b0222137620a5111e1fd10edf68c1f5ca7778a232355fc67237bd6eddf69",
  "modules/supervisor/durable-queue.js": "ab7b69fdb8f3e3a2065900fc56d459495d864391f52cfba41a30433c0998d951",
  "modules/supervisor/ticket-dependency-expectations.js": "cf987d85b7b99e66b119ebfbac89f04f4f2823960ed63f504e971ba2991341ac",
  "application/ticket-run-dispatch.js": "7906c9cd543411358d0092db3e56b4e741527e293606544f7db9b248f6013161"
});

// Checks the declared source manifest inside the verification run, rather than assigning later reads to an earlier PASS.
async function assertSourceManifest() {
  for (const [path, expected] of Object.entries(SOURCE_IDENTITIES)) {
    const bytes = await readFile(new URL(`../../src/${path}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, `Source changed during recovery verification: ${path}`);
  }
}
test.before(assertSourceManifest);
test.after(assertSourceManifest);

// Creates durable approved fixture identity and cleans up runtime instances before disposing test storage.
async function withStorage(callback) {
  const root = await mkdtemp(join(tmpdir(), "ticket-launch-recovery-"));
  const runtimes = [];
  let storage;
  try {
    await initializeDispatchStorage(root);
    storage = await openDispatchStorage(root);
    await callback({ root, runtimes, ...storage });
  } finally {
    for (const runtime of runtimes) { runtime.senderWorker.stop(); runtime.collectorWorkerLoop.stop(); runtime.verificationWorkerLoop.stop(); }
    await storage?.database.close();
    await rm(root, { recursive: true, force: true });
  }
}

for (const state of ["checkpoint", "COMPLETED", "FAILED", "NEEDS_HUMAN_REVIEW", "RUNNING", "REPAIRING"]) {
  test(`restart with retained launch and ${state} does not release ownership or resume provider work`, async () => withStorage(async (f) => {
    const basis = f.registry.get(TICKET.sprint_id);
    f.store.beginExecution(TICKET.id, { executionId: "RUN-UNKNOWN", basis, expectedVersion: f.store.get(TICKET.id).version, dependencyExpectations: [] });
    const receipt = f.store.claimExecutionLaunch(TICKET.id, { executionId: "RUN-UNKNOWN", basis, requestId: "REQ-UNKNOWN", jobId: "JOB-UNKNOWN", supervisorId: `SUP-${TICKET.id}`, agentId: "coder", claimId: "CLAIM-UNKNOWN", validate: () => {} });
    const released = []; const events = []; const logs = [];
    const claim = { claim_id: "CLAIM-UNKNOWN", task_id: TICKET.id, supervisor_id: receipt.supervisor_id, agent_id: "coder" };
    const occupancy = { listActive: () => [claim], getByTask: () => claim, release: async (input) => released.push(input) };
    const options = { fileService: f.files, projectRoot: f.root, root: "recovery", ticketStatusStore: f.store, sprintRegistry: f.registry, agentOccupancy: occupancy, autoStartWorkers: false, projectLogger: (entry) => logs.push(entry), logger: { info() {}, debug() {} }, gitService: { status: async () => "" } };
    const first = createProductionSupervisorRuntime(options); f.runtimes.push(first);
    first.eventBus.subscribe("*", (event) => events.push(event));
    await first.agentCheckpoints.save({ task_id: TICKET.id, status: "completed", changed_paths: ["backend/src/example.js"] });
    if (state !== "checkpoint") await first.stateStore.save({ task_id: TICKET.id, supervisor_id: receipt.supervisor_id, state, pending_request: { ticket: TICKET, project_id: PROJECT, request_id: "REQ-UNKNOWN", correlation_id: "CORR-UNKNOWN", attempt: 1, payload: { execution_id: receipt.execution_id, sprint_basis: basis, dependency_expectations: [] } }, updated_at: new Date().toISOString() });
    const restarted = createProductionSupervisorRuntime(options); f.runtimes.push(restarted);
    restarted.eventBus.subscribe("*", (event) => events.push(event));
    await restarted.recover();
    await restarted.recover();
    assert.deepEqual(released, []);
    assert.equal(events.some((event) => event.type === "task.needs_human_review"), false);
    assert.deepEqual(f.store.get(TICKET.id).details.launch_claim, receipt);
    assert.deepEqual(await restarted.queueStore.list("agent.request"), []);
    assert.ok(logs.some((entry) => entry.event_name === "supervisor.launch_reconciliation_required" && entry.payload.execution_id === receipt.execution_id));
  }));
}

for (const state of ["checkpoint", "COMPLETED"]) {
  test(`recovery without a retained launch preserves ${state} release behavior`, async () => withStorage(async (f) => {
    const released = [];
    const claim = { claim_id: "CLAIM-LEGACY", task_id: "TASK-LEGACY", supervisor_id: "SUP-TASK-LEGACY", agent_id: "coder" };
    const runtime = createProductionSupervisorRuntime({ fileService: f.files, root: "legacy", agentOccupancy: { listActive: () => [claim], release: async (input) => released.push(input) }, ticketStatusStore: f.store, autoStartWorkers: false, logger: { info() {}, debug() {} }, gitService: { status: async () => "" } });
    f.runtimes.push(runtime);
    await runtime.agentCheckpoints.save({ task_id: claim.task_id, status: "completed" });
    if (state !== "checkpoint") await runtime.stateStore.save({ task_id: claim.task_id, supervisor_id: claim.supervisor_id, state, pending_request: {}, updated_at: new Date().toISOString() });
    await runtime.recover();
    assert.equal(released.length, 1);
  }));
}

test("Registry submission rejects omitted intent and claimed review-resume before preparation, while standalone stays compatible", async () => withStorage(async (f) => {
  const prepared = [];
  const integration = createNodeforgeTaskIntegration({ supervisorManager: { startTask: async () => ({}) }, eventBus: { publish: async () => {} }, handoffQueue: f.queue, sprintRegistry: f.registry, ticketStatusStore: f.store, agentResolver: { resolveAvailable: () => null }, resolveTicketWorkspace: async () => { prepared.push(true); return null; } });
  for (const payload of [{}, { direct_code: true }, { review_resume: { agent_id: "coder" } }]) {
    await assert.rejects(integration.submitTicket({ ticket: TICKET, project_id: PROJECT, payload }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", retryable: false });
  }
  const basis = f.registry.get(TICKET.sprint_id);
  f.store.beginExecution(TICKET.id, { executionId: "RUN-UNKNOWN", basis, expectedVersion: f.store.get(TICKET.id).version, dependencyExpectations: [] });
  f.store.claimExecutionLaunch(TICKET.id, { executionId: "RUN-UNKNOWN", basis, requestId: "REQ-A", jobId: "JOB-A", supervisorId: "SUP-A", agentId: "coder", validate: () => {} });
  await assert.rejects(integration.submitTicket({ ticket: TICKET, project_id: PROJECT, payload: { execution_id: "RUN-UNKNOWN", sprint_basis: basis, dependency_expectations: [], review_resume: { agent_id: "coder" } } }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
  assert.deepEqual(prepared, []);
  assert.deepEqual(await f.queueStore.list("sender.handoff"), []);
  assert.doesNotThrow(() => assertDependencySubmission({ ticket: { id: "CODE-STANDALONE" }, payload: { direct_code: true }, projectId: PROJECT, sprintRegistry: f.registry, ticketStatusStore: f.store }));
}));

test("individual Registry RUN captures omitted dependency intent before durable execution and dispatch", async () => withStorage(async (f) => {
  const calls = [];
  const dispatch = createTicketRunDispatch({ disposition: { get: async () => null }, intake: { open: async () => ({ ticket: TICKET }) }, sprintRegistry: f.registry, ticketStatusStore: f.store,
    checkpoints: { load: async () => null, clear: async () => {} }, protocolStorage: { clearTask: async () => {} }, conversationStateStore: { clear: async () => {} },
    dispatchTask: async (request) => { calls.push(request); return { status: "completed" }; } });
  await dispatch({ projectId: PROJECT, ticketId: TICKET.id });
  assert.deepEqual(calls[0].dependencyExpectations, []);
  assert.deepEqual(f.store.get(TICKET.id).details.dependency_expectations, []);
  const basis = f.registry.get(TICKET.sprint_id);
  await assert.rejects(captureDependencyExpectations({ projectId: PROJECT, ticket: { ...TICKET, dependencies: ["TICKET-MISSING"] }, sprintRegistry: { getByTicket: async () => basis }, ticketStatusStore: f.store }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
}));
