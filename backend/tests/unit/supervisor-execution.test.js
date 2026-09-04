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

test("supervisor manager keeps task and supervisor registries isolated", () => {
  const bus = createExecutionEventBus(); const manager = createSupervisorManager({ eventBus: bus, idFactory: () => "SUP-A" });
  const runtime = manager.startTask({ task_id: "TASK-A" });
  assert.equal(manager.getByTask("TASK-A"), runtime); assert.equal(manager.getBySupervisor("SUP-A"), runtime);
  assert.equal(manager.stopTask("TASK-A"), true); assert.equal(manager.getByTask("TASK-A"), null);
});


test("production recovery restores supervisor and queue state across restart states", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-recovery-"));
  const fileService = createFileService({ projectRoot: root });
  const gateway = { request: async () => ({ status: "completed", payload: { ok: true } }) };
  const states = ["WAITING_AGENT", "MATERIALIZING", "VERIFYING", "REPAIRING"];
  for (const state of states) {
    const first = createProductionSupervisorRuntime({ fileService, root: "runtime", agentGateway: gateway, logger: { info() {} } });
    const started = await first.integration.startTask({ task_id: `TASK-${state}`, project_id: "PROJECT", request_id: `REQ-${state}`, correlation_id: `CORR-${state}` });
    const runtime = first.supervisorManager.getByTask(`TASK-${state}`);
    await runtime.transition(state, { request_id: `REQ-${state}`, correlation_id: `CORR-${state}`, attempt: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    first.senderWorker.stop(); first.repairWorker.stop(); first.materializerWorkerLoop.stop(); first.verificationWorkerLoop.stop();
    const second = createProductionSupervisorRuntime({ fileService, root: "runtime", agentGateway: gateway, logger: { info() {} } });
    await second.recover();
    const recovered = second.supervisorManager.getByTask(`TASK-${state}`);
    assert.equal(recovered?.supervisorId, started.supervisor_id);
    assert.equal(recovered?.getState(), state);
    second.senderWorker.stop(); second.repairWorker.stop(); second.materializerWorkerLoop.stop(); second.verificationWorkerLoop.stop();
  }
});
