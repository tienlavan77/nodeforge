// Verifies application disposal stops recovery polling before SQLite closes,
// including an in-flight scan and Control API shutdown through the project lifecycle.
import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createBlockerRecoveryPoller } from "../../src/modules/supervisor/blocker/blocker-recovery-poller.js";
import { createCoderOperationalRecovery } from "../../src/modules/supervisor/coder/coder-operational-recovery.js";
import { createApplicationDisposal, registerSupervisorWorkers } from "../../scripts/control-api-application-disposal.mjs";
import { createProjectApplicationRegistry } from "../../scripts/control-api-project-applications.mjs";
import { startControlApi } from "../../scripts/control-api-lifecycle.mjs";

// Gives each test a real database whose closed state exposes stale recovery reads.
async function withDatabase(run) {
  const root = await mkdtemp(join(tmpdir(), "forge-worker-disposal-"));
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  try { await run({ root, database }); }
  finally { await database.close(); await rm(root, { recursive: true, force: true }); }
}

// Covers both project-removal disposal and a second cleanup through the API rollback path.
test("project application cleanup stops both recovery timers before closing real SQLite", async (context) => withDatabase(async ({ root, database }) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const errors = [], stopped = [];
  let reads = 0;
  // Models the database-backed status lookup performed by real recovery reservation scans.
  const read = () => { reads += 1; database.read("SELECT 1"); };
  const blockerRecovery = createBlockerRecoveryPoller({ tick: read, logger: { error: (...args) => errors.push(args) } });
  const coderRecovery = createCoderOperationalRecovery({
    store: { withLock: async (_name, run) => run(), list: async () => { read(); return []; }, save: async () => {} },
    policy: { policy_id: "TEST", max_retries: 1, deadline_ms: 60_000 },
    validateExecution: async () => true, dispatch: async () => {}, publishTerminal: async () => {},
    logger: { error: (...args) => errors.push(args) }
  });
  const disposal = createApplicationDisposal();
  const workers = registerSupervisorWorkers({ blockerRecovery, coderRecovery,
    senderWorker: { stop: () => stopped.push("sender") },
    collectorWorkerLoop: { stop: () => stopped.push("collector") },
    verificationWorkerLoop: { stop: () => stopped.push("verification") } }, disposal);
  assert.equal(workers.length, 5);
  const applications = createProjectApplicationRegistry({ defaultRoot: root,
    defaultApplication: { workers, services: {}, storage: { disposal, controlDb: database } } });
  try {
    await coderRecovery.start(); await blockerRecovery.start(); await nextTurn();
    const readsBeforeClose = reads;
    await applications.close(); await disposal.close();
    context.mock.timers.tick(5000); await nextTurn();
    assert.equal(reads, readsBeforeClose);
    assert.deepEqual(errors, []);
    assert.deepEqual(stopped, ["sender", "collector", "verification"]);
    assert.throws(() => database.read("SELECT 1"), /Database service is closed/);
  } finally { await applications.close(); }
}));

// Ensures cleanup waits for an already reserved scan instead of closing its store underneath it.
test("blocker stop drains its active scan before application disposal closes SQLite", async () => withDatabase(async ({ database }) => {
  let finish, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { finish = resolve; });
  const events = [], errors = [];
  const recovery = createBlockerRecoveryPoller({ logger: { error: (...args) => errors.push(args) },
    tick: async () => { entered(); await gate; database.read("SELECT 1"); events.push("scan"); } });
  const disposal = createApplicationDisposal();
  registerSupervisorWorkers({ blockerRecovery: recovery }, disposal);
  disposal.own({ close: async () => { events.push("database"); await database.close(); } }, "close", 50);
  await recovery.start(); await started;
  const closing = disposal.close();
  try {
    await nextTurn(); assert.deepEqual(events, []);
    finish(); await closing;
    assert.deepEqual(events, ["scan", "database"]);
    assert.deepEqual(errors, []);
  } finally { finish(); await closing; }
}));

// Shutdown must stop default-stack recovery before project lifecycle cleanup can close borrowed stores.
test("Control API stops workers before project lifecycle databases, even when a stop fails", async () => {
  const events = [];
  const api = startControlApi({ api: { createServer }, port: 0, host: "127.0.0.1",
    workers: [{ stop: async () => { events.push("worker"); throw new Error("Injected stop failure"); } },
      { stop: async () => events.push("recovery") }],
    projectLifecycle: { close: async () => events.push("project") },
    indexDb: { close: async () => events.push("index") }, controlDb: { close: async () => events.push("control") },
    processLock: { release: () => events.push("lock") } });
  await once(api.server, "listening");
  const closing = api.shutdown();
  assert.equal(api.shutdown(), closing);
  await assert.rejects(closing, (error) => error instanceof AggregateError && error.errors.length === 1);
  assert.deepEqual(events, ["worker", "recovery", "project", "index", "control", "lock"]);
});
