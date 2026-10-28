// Reproduces API-crashing RUN wait log failures against the real persisted log schema and queue.
// Diagnostic errors must not replace durable dispatch outcomes or escape background rejection handlers.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTicketRunAgentWait } from "../../src/application/ticket-run-agent-wait.js";
import { logEvent } from "../../src/core/project-log-service.js";
import { initializeDispatchStorage, openDispatchStorage, PROJECT, TICKET } from "../fixtures/ticket-dispatch-recovery-fixture.mjs";

const QUEUE = "ticket.run-agent-wait";
const REQUEST = { projectId: PROJECT, ticketId: TICKET.id };

// Saves actual availability intent and lets each test control the deferred dispatch and its logging sink.
async function fixture(t, projectLogger) {
  const root = await mkdtemp(join(tmpdir(), "run-wait-log-"));
  await initializeDispatchStorage(root);
  const f = await openDispatchStorage(root);
  const state = { now: 1000, busy: true, failure: null, calls: 0 };
  const run = createTicketRunAgentWait({ queueStore: f.queueStore, ticketStatusStore: f.store, projectId: PROJECT,
    projectLogger: (entry) => projectLogger(entry, root), clock: () => state.now,
    dispatch: async () => {
      state.calls++;
      if (state.busy) throw Object.assign(new Error("Coder occupied"), { code: "AGENT_BUSY", not_started: true,
        ticket_run_wait: {}, agent_wait: { claim_id: "CLAIM", agent_id: "CODER" } });
      if (state.failure) throw state.failure;
      return { status: "accepted" };
    } });
  t.after(async () => { run.close(); await f.database.close(); await rm(root, { recursive: true, force: true }); });
  return { ...f, root, state, run };
}

// Waits for detached reporting to finish so an unhandled rejection also fails under the Node test runner.
async function flush() { await new Promise((resolve) => setTimeout(resolve, 100)); }

test("raw project logger persists busy retries, Stop and dispatch failure without rejecting saved RUN intent", async (t) => {
  const f = await fixture(t, (entry, root) => logEvent(entry, { logPath: join(root, "events.log") }));
  const first = await f.run(REQUEST);
  assert.equal(first.queued, true);
  f.state.now += 30000; await f.run.tick(); await flush();
  assert.equal((await f.queueStore.list(QUEUE))[0].attempts, 2);
  await f.run.stop(REQUEST);
  assert.equal((await f.queueStore.list(QUEUE))[0].status, "cancelled");
  await f.run(REQUEST);
  f.state.busy = false;
  f.state.failure = Object.assign(new Error("Original dependency conflict"), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
  f.state.now += 30000; await f.run.tick(); await flush();
  const saved = (await f.queueStore.list(QUEUE)).at(-1);
  assert.equal(saved.status, "failed");
  assert.equal(saved.error.code, f.state.failure.code);
  const events = (await readFile(join(f.root, "events.log"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(events.some((event) => event.event_name === "ticket.run_wait_stopped"));
  assert.equal(events.at(-1).error_code, f.state.failure.code);
  assert.ok(events.every((event) => event.source === "ticket-run-agent-wait" && event.project_id === PROJECT));
});

for (const asynchronous of [false, true]) {
  test(`a ${asynchronous ? "rejected" : "throwing"} log sink cannot fail durable RUN or crash detached retry`, async (t) => {
    const errors = [];
    t.mock.method(console, "error", (...args) => errors.push(args));
    const f = await fixture(t, () => {
      const error = Object.assign(new Error("Log storage unavailable"), { code: "LOG_STORAGE_FAILED" });
      if (asynchronous) return Promise.reject(error);
      throw error;
    });
    assert.equal((await f.run(REQUEST)).queued, true);
    f.state.busy = false;
    f.state.failure = Object.assign(new Error("Dispatch failed"), { code: "ORIGINAL_DISPATCH_FAILURE" });
    f.state.now += 30000;
    await f.run.tick(); await flush();
    const entry = (await f.queueStore.list(QUEUE))[0];
    assert.equal(entry.status, "failed");
    assert.equal(entry.error.code, "ORIGINAL_DISPATCH_FAILURE");
    assert.equal(errors.length, 2);
    assert.equal(errors[1][1].code, "LOG_STORAGE_FAILED");
  });
}

test("automatic queue poll reports its original storage error even when the log sink also fails", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const events = [];
  const run = createTicketRunAgentWait({ projectId: PROJECT, queueStore: {
    withLock: async () => { throw Object.assign(new Error("Queue read unavailable"), { code: "QUEUE_READ_FAILED" }); }
  }, projectLogger: (entry) => { events.push(entry); throw new Error("Log unavailable"); } });
  t.after(() => run.close());
  run.start(); t.mock.timers.tick(1000); await flush();
  assert.equal(events[0].error_code, "QUEUE_READ_FAILED");
  assert.equal(events[0].event_name, "ticket.run_wait_poll_failed");
  assert.equal(errors.length, 1);
});
