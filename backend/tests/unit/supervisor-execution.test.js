import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionEventBus } from "../../src/modules/supervisor/execution-event-bus.js";
import { createDurableQueue } from "../../src/modules/supervisor/durable-queue.js";
import { createSupervisorManager } from "../../src/modules/supervisor/supervisor-manager.js";
import { createProductionSupervisorRuntime } from "../../src/modules/supervisor/production-runtime.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("execution event bus routes only to matching supervisor and persists ordering", async () => {
  const received = []; const persisted = [];
  const bus = createExecutionEventBus({ eventStore: { append: async (event) => persisted.push(event) } });
  bus.subscribe("SUP-A", (event) => received.push(event));
  await bus.publish({ type: "x", task_id: "TASK-A", supervisor_id: "SUP-A", request_id: "REQ-1", correlation_id: "CORR-A", attempt: 1, payload: {} });
  assert.equal(received.length, 1); assert.equal(persisted[0].sequence, 1);
});

test("durable queue deduplicates request and recovers expired leases", async () => {
  const items = new Map(); let now = 1000;
  const store = { list: async () => [...items.values()], save: async (_name, item) => items.set(item.id, item) };
  const queue = createDurableQueue({ name: "agent.request", store, clock: () => now, leaseMs: 10 });
  const first = await queue.enqueue({ request_id: "REQ-1", payload: {} });
  assert.equal((await queue.enqueue({ request_id: "REQ-1", payload: {} })).id, first.id);
  await queue.claim("worker"); now = 1020; await queue.recover();
  assert.equal([...items.values()][0].status, "queued");
});

test("supervisor manager keeps task and supervisor registries isolated", async () => {
  const bus = createExecutionEventBus(); const manager = createSupervisorManager({ eventBus: bus, idFactory: () => "SUP-A" });
  const runtime = await manager.startTask({ task_id: "TASK-A" });
  assert.equal(manager.getByTask("TASK-A"), runtime); assert.equal(manager.getBySupervisor("SUP-A"), runtime);
  assert.equal(manager.stopTask("TASK-A"), true); assert.equal(manager.getByTask("TASK-A"), null);
});


test("production recovery restores supervisor and queue state across restart states", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-recovery-"));
  const fileService = createFileService({ projectRoot: root });
  const gateway = { request: async () => ({ status: "completed", payload: { ok: true } }) };
  const states = ["RUNNING", "VERIFYING", "REPAIRING"];
  for (const state of states) {
    const first = createProductionSupervisorRuntime({ fileService, root: "runtime", agentGateway: gateway, logger: { info() {} }, autoStartWorkers: false, gitService: { status: async () => "" } });
    const started = await first.integration.startTask({ task_id: `TASK-${state}`, project_id: "PROJECT", request_id: `REQ-${state}`, correlation_id: `CORR-${state}` });
    const runtime = first.supervisorManager.getByTask(`TASK-${state}`);
    await runtime.transition(state, { request_id: `REQ-${state}`, correlation_id: `CORR-${state}`, attempt: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    first.senderWorker.stop(); first.collectorWorkerLoop.stop(); first.verificationWorkerLoop.stop();
    const second = createProductionSupervisorRuntime({ fileService, root: "runtime", agentGateway: gateway, logger: { info() {} }, autoStartWorkers: false, gitService: { status: async () => "" } });
    await second.recover();
    const recovered = second.supervisorManager.getByTask(`TASK-${state}`);
    assert.equal(recovered?.supervisorId, started.supervisor_id);
    assert.equal(recovered?.getState(), state);
    second.senderWorker.stop(); second.collectorWorkerLoop.stop(); second.verificationWorkerLoop.stop();
  }
});

test("persistent task ownership resolves concurrent managers to one supervisor", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-ownership-"));
  const fileService = createFileService({ projectRoot: root });
  const storeA = (await import("../../src/modules/supervisor/supervisor-state-store.js")).createSupervisorStateStore({ fileService, root: "runtime/supervisors" });
  const storeB = (await import("../../src/modules/supervisor/supervisor-state-store.js")).createSupervisorStateStore({ fileService, root: "runtime/supervisors" });
  const managerA = createSupervisorManager({ eventBus: createExecutionEventBus(), stateStore: storeA, idFactory: () => "SUP-A" });
  const managerB = createSupervisorManager({ eventBus: createExecutionEventBus(), stateStore: storeB, idFactory: () => "SUP-B" });
  const [a, b] = await Promise.all([managerA.startTask({ task_id: "TASK-SHARED" }), managerB.startTask({ task_id: "TASK-SHARED" })]);
  assert.equal(a.supervisorId, b.supervisorId);
  const ownership = JSON.parse(await fileService.readFile({ path: `runtime/supervisors/pending/${a.supervisorId}.json` }));
  assert.equal(ownership.supervisor_id, a.supervisorId);
});

test("explicit rerun reopens a terminal supervisor without creating a new owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-rerun-"));
  const fileService = createFileService({ projectRoot: root });
  const makeStore = () => import("../../src/modules/supervisor/supervisor-state-store.js").then(({ createSupervisorStateStore }) => createSupervisorStateStore({ fileService, root: "runtime/supervisors" }));
  const first = createSupervisorManager({ eventBus: createExecutionEventBus(), stateStore: await makeStore(), idFactory: () => "SUP-RERUN" });
  const owner = await first.startTask({ task_id: "TASK-RERUN" });
  const runtime = first.getByTask("TASK-RERUN");
  for (const [state, request_id] of [["RUNNING", "REQ-1"], ["VERIFYING", "REQ-1"], ["COMPLETED", "REQ-1"]]) await runtime.transition(state, { request_id, correlation_id: "CORR-1", attempt: 1 });
  const second = createSupervisorManager({ eventBus: createExecutionEventBus(), stateStore: await makeStore(), idFactory: () => "SUP-NEW" });
  const rerun = await second.startTask({ task_id: "TASK-RERUN" });
  const rerunSnapshot = JSON.parse(await fileService.readFile({ path: `runtime/supervisors/pending/${owner.supervisorId}.json` }));
  assert.equal(rerunSnapshot.pending_request.attempt, 2);
  assert.equal(rerun.supervisorId, owner.supervisorId);
  assert.equal(rerun.getState(), "CREATED");
  assert.equal(rerun.wasReset, true);
  const store = await makeStore();
  assert.equal((await store.list({ scope: "complete" })).length, 0);
  assert.equal((await store.list({ scope: "pending" })).length, 1);
});

test("file-backed queue serializes concurrent mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-queue-atomic-"));
  const fileService = createFileService({ projectRoot: root });
  const store = (await import("../../src/modules/supervisor/file-queue-store.js")).createFileQueueStore({ fileService, root: "runtime/queues" });
  const first = createDurableQueue({ name: "agent.request", store });
  const second = createDurableQueue({ name: "agent.request", store });
  await Promise.all(Array.from({ length: 12 }, (_, i) => first.enqueue({ request_id: `REQ-${i}`, payload: { i } })));
  const claimed = await Promise.all(Array.from({ length: 12 }, (_, i) => second.claim(`worker-${i}`)));
  assert.equal(claimed.filter(Boolean).length, 12);
  const items = await store.list("agent.request");
  assert.equal(items.length, 12);
  await Promise.all(items.map((item) => first.ack(item.id)));
  assert.equal((await store.list("agent.request")).every((item) => item.status === "completed"), true);
});

test("failed event handling is surfaced to the project log", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-event-failed-"));
  const fileService = createFileService({ projectRoot: root });
  const gateway = { request: async () => { throw new Error("gateway offline"); } };
  const logged = [];
  const runtime = createProductionSupervisorRuntime({
    fileService, root: "runtime", agentGateway: gateway, logger: { info() {}, error() {} }, projectLogger: (entry) => logged.push(entry), gitService: { status: async () => "" },
    attemptBuilderFactory: () => ({ onResponse: async () => { const error = new Error("R1 expected code_needed"); error.code = "ROUND_INVALID"; throw error; } })
  });
  const started = await runtime.integration.startTask({ task_id: "TASK-EVENT-FAIL", project_id: "PROJECT", request_id: "REQ-EF", correlation_id: "CORR-EF" });
  await runtime.eventBus.publish({ type: "agent.response.received", task_id: "TASK-EVENT-FAIL", supervisor_id: started.supervisor_id, request_id: "REQ-EF", correlation_id: "CORR-EF", attempt: 1, payload: { response: { type: "code_needed", files_requested: [], reason: "x" } } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const entry = logged.find((item) => item.event_name === "supervisor.event_failed");
  assert.ok(entry, "expected a supervisor.event_failed project log entry");
  assert.equal(entry.level, "error");
  assert.equal(entry.status, "failed");
  assert.equal(entry.payload.event_type, "agent.response.received");
  assert.equal(entry.payload.error_code, "ROUND_INVALID");
  runtime.senderWorker.stop(); runtime.collectorWorkerLoop.stop(); runtime.verificationWorkerLoop.stop();
});
