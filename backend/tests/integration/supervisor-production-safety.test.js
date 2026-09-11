import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createSupervisorStateStore } from "../../src/modules/supervisor/supervisor-state-store.js";
import { createExecutionEventBus } from "../../src/modules/supervisor/execution-event-bus.js";

function runWorker(root) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL("../fixtures/supervisor-ownership-worker.mjs", import.meta.url), [root], { silent: true });
    let output = ""; child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve(JSON.parse(output.trim())) : reject(new Error(`worker exited ${code}: ${output}`)));
  });
}

test("multi-process Supervisor recovery preserves one owner and one request claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-supervisor-e2e-"));
  const [first, second] = await Promise.all([runWorker(root), runWorker(root)]);
  assert.equal(first.supervisor_id, second.supervisor_id);
  assert.equal([first.claimed, second.claimed].filter(Boolean).length, 1);
  const fileService = createFileService({ projectRoot: root });
  const stateStore = createSupervisorStateStore({ fileService, root: "runtime/supervisors" });
  const states = await stateStore.list();
  assert.equal(states.length, 1);
  assert.equal(states[0].task_id, "TASK-MULTI-PROCESS");
  const claims = await readdir(join(root, "runtime/requests/claims"));
  assert.equal(claims.filter((name) => name.endsWith(".json")).length, 1);
  assert.equal(JSON.parse(await readFile(join(root, `runtime/supervisors/pending/${first.supervisor_id}.json`))).supervisor_id, first.supervisor_id);
});

test("duplicate event_id is delivered once after persistent claim", async () => {
  const records = new Map(); const store = { append: async (event) => { if (records.has(event.event_id)) return { accepted: false, event: records.get(event.event_id) }; records.set(event.event_id, event); return { accepted: true, event }; }, getById: (id) => records.get(id) };
  const bus = createExecutionEventBus({ eventStore: store }); let deliveries = 0; bus.subscribe("SUP-E2E", () => { deliveries += 1; });
  const event = { event_id: "EVT-DUP-E2E", type: "agent.response.received", task_id: "TASK-E2E", supervisor_id: "SUP-E2E", request_id: "REQ-E2E", correlation_id: "CORR-E2E", attempt: 1, payload: {} };
  await Promise.all([bus.publish(event), bus.publish(event)]); assert.equal(deliveries, 1); assert.equal(records.size, 1);
});
