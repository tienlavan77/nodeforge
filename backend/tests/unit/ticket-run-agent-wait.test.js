// Verifies initial RUN availability waits against actual SQLite, immutable plans and file queues.
// Tests use controlled occupancy and time, preserving production dispatch gates without an SDK call.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDispatchStorage, openDispatchStorage, PROJECT, TICKET } from "../fixtures/ticket-dispatch-recovery-fixture.mjs";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";
import { selectTicketCoder } from "../../src/modules/supervisor/ticket-agent-provider-routing.js";
import { createFileQueueStore } from "../../src/modules/supervisor/file-queue-store.js";
import { createSprintDagRunner } from "../../src/modules/supervisor/sprint-dag.js";
import { createExecutionEventBus } from "../../src/modules/supervisor/execution-event-bus.js";

const QUEUE = "ticket.run-agent-wait";
const REQUEST = { projectId: PROJECT, ticketId: TICKET.id };

// Creates real durable storage while controlling Coder occupancy, launch races and provider completion.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ticket-agent-wait-"));
  await initializeDispatchStorage(root);
  const f = await openDispatchStorage(root);
  const state = { now: 1000, busy: true, enabled: true, launches: 0, refreshes: 0, clears: [], logs: [] };
  // Mirrors persisted role and occupancy readiness without invoking a provider.
  const profile = () => ({ agent_id: "CODER", role: "coder", provider: "codex", enabled: state.enabled, status: state.busy ? "working" : "ready" });
  const resolver = { refresh: async () => { state.refreshes++; }, list: () => [profile()], resolveAvailable: () => state.busy ? undefined : profile() };
  const occupancy = { listActive: () => state.busy ? [{ agent_id: "CODER", claim_id: "BUSY", task_id: "OTHER", supervisor_id: "OTHER-SUP", project_id: "OTHER-PROJECT" }] : [],
    getByTask: () => null, claim: async () => state.busy ? null : { claim_id: "CLAIM", agent_id: "CODER" } };
  const dispatches = [];
  // Recreates the dispatcher and queue cache as a replacement API process would after a restart.
  function recreate(overrides = {}) {
    const dispatch = createTicketRunDispatch({ disposition: { get: async () => null }, intake: { open: async () => ({ ticket: structuredClone(TICKET) }) },
      sprintRegistry: f.registry, ticketStatusStore: f.store, queueStore: createFileQueueStore({ fileService: f.files }), agentResolver: resolver, agentOccupancy: occupancy,
      projectId: PROJECT, clock: () => state.now, projectLogger: (entry) => state.logs.push(entry),
      checkpoints: { load: async () => null, clear: async () => state.clears.push("checkpoint") },
      protocolStorage: { clearTask: async () => state.clears.push("protocol") }, conversationStateStore: { clear: async () => state.clears.push("conversation") },
      dispatchTask: async (input) => {
        if (state.race) { state.race = false; state.busy = true; }
        await selectTicketCoder({ resolver, occupancy, ticket: input.ticket, taskId: TICKET.id, ownerId: `SUP-${TICKET.id}`, payload: {} });
        state.launches++;
        await state.onLaunch?.(input);
        return { status: "accepted" };
      }, ...overrides });
    dispatches.push(dispatch);
    return dispatch;
  }
  return { ...f, root, state, resolver, occupancy, recreate, entries: () => f.queueStore.withLock(QUEUE, () => f.queueStore.list(QUEUE)),
    close: async () => { for (const dispatch of dispatches) dispatch.close(); await f.database.close(); await rm(root, { recursive: true, force: true }); } };
}

// Waits only for detached queue completion, failing quickly when a dispatch becomes stuck.
async function settled(f, expected = "completed") {
  for (let index = 0; index < 300; index++) {
    const entry = (await f.entries()).at(-1);
    if (entry?.status === expected) return entry;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Queue did not reach ${expected}`);
}

test("initial RUN queues any busy Coder, retains state, and launches once after 30 seconds across restart", async () => {
  const f = await fixture();
  try {
    const dispatch = f.recreate();
    const result = await dispatch(REQUEST);
    assert.equal(result.queued, true);
    assert.equal(result.agent_wait.busy_task_id, "OTHER");
    assert.equal(f.store.get(TICKET.id).status, "pending");
    assert.deepEqual(f.state.clears, []);
    assert.equal(f.state.launches, 0);
    const basis = (await f.entries())[0].request.expectedExecutionBasis;
    assert.equal(basis.plan_id, "PLAN-DISPATCH");
    assert.equal((await dispatch(REQUEST)).queued, true);
    assert.equal((await f.entries()).length, 1);
    const replacement = f.recreate();
    f.state.busy = false; f.state.now += 29_999;
    await replacement.tick(); assert.equal(f.state.launches, 0);
    f.state.now++;
    await Promise.all([dispatch.tick(), replacement.tick()]);
    await settled(f);
    assert.equal(f.state.launches, 1);
    assert.equal(f.store.get(TICKET.id).status, "running");
    assert.ok(f.state.refreshes >= 2);
    assert.match(f.state.logs[0].message, /30 giây.*Stop/);
  } finally { await f.close(); }
});

test("continued occupancy renews only the wait, with no consultation or destructive preparation", async () => {
  const f = await fixture();
  try {
    const dispatch = f.recreate(); await dispatch(REQUEST);
    for (let round = 0; round < 3; round++) {
      f.state.now += 30_000; await dispatch.tick(); await settled(f, "waiting");
      assert.equal((await f.entries())[0].attempts, round + 2);
      assert.equal((await f.entries()).length, 1);
    }
    assert.equal(f.state.launches, 0);
    assert.deepEqual(f.state.clears, []);
  } finally { await f.close(); }
});

test("Stop survives restart and release; a later explicit RUN can queue again", async () => {
  const f = await fixture();
  try {
    const dispatch = f.recreate(); await dispatch(REQUEST);
    await assert.rejects(dispatch.stop({ ...REQUEST, projectId: "OTHER-PROJECT" }), { code: "TICKET_NOT_RUNNING" });
    assert.equal((await f.entries())[0].status, "waiting");
    assert.equal((await dispatch.stop(REQUEST)).status, "stopped");
    const replacement = f.recreate(); f.state.busy = false; f.state.now += 30_000;
    await replacement.tick();
    assert.equal(f.state.launches, 0);
    assert.equal((await f.entries())[0].status, "cancelled");
    f.state.busy = true;
    assert.equal((await replacement(REQUEST)).queued, true);
    assert.equal((await f.entries()).length, 2);
  } finally { await f.close(); }
});

test("disabled profiles fail instead of entering an endless availability queue", async () => {
  const f = await fixture();
  try {
    f.state.enabled = false;
    await assert.rejects(f.recreate()(REQUEST), { code: "AGENT_NOT_AVAILABLE" });
    assert.equal((await f.entries()).length, 0);
  } finally { await f.close(); }
});

test("concurrent ticket-state replacement retires queued intent without launching", async () => {
  const f = await fixture();
  try {
    const dispatch = f.recreate(); await dispatch(REQUEST);
    f.store.updateStatus(TICKET.id, "blocked", { reason: "owner_pause" });
    f.state.busy = false; f.state.now += 30_000;
    await dispatch.tick();
    assert.equal((await f.entries())[0].status, "superseded");
    assert.equal(f.state.launches, 0);
  } finally { await f.close(); }
});

test("changed Sprint revision stops retry at normal gates and emits the exact error", async () => {
  const f = await fixture();
  try {
    const dispatch = f.recreate(); await dispatch(REQUEST);
    const basis = f.registry.get(TICKET.sprint_id);
    await f.registry.setStatus({ sprintId: TICKET.sprint_id, status: "running", expectedVersion: basis.version });
    f.state.busy = false; f.state.now += 30_000;
    await dispatch.tick();
    const entry = await settled(f, "failed");
    assert.ok(entry.error.code);
    assert.equal(f.state.launches, 0);
    assert.deepEqual(f.state.clears, []);
  } finally { await f.close(); }
});

test("atomic claim race after preparation returns to durable wait before any provider launch", async () => {
  const f = await fixture();
  try {
    f.state.busy = false; f.state.race = true;
    const dispatch = f.recreate();
    assert.equal((await dispatch(REQUEST)).queued, true);
    assert.equal(f.store.get(TICKET.id).status, "pending");
    f.state.busy = false; f.state.now += 30_000;
    await dispatch.tick(); await settled(f);
    assert.equal(f.state.launches, 1);
  } finally { await f.close(); }
});

test("Stop at the reserved launch boundary aborts the same invocation without requeue", async () => {
  const f = await fixture();
  try {
    const dispatch = f.recreate(); await dispatch(REQUEST);
    f.state.onLaunch = async (input) => {
      await dispatch.stop(REQUEST);
      assert.equal(input.abortSignal.aborted, true);
      throw input.abortSignal.reason;
    };
    f.state.busy = false; f.state.now += 30_000;
    await dispatch.tick(); await settled(f, "cancelled");
    // Wait until the detached collector has persisted the stopped dispatch outcome.
    for (let index = 0; index < 100 && f.store.get(TICKET.id).status === "running"; index++) await new Promise((resolve) => setTimeout(resolve, 10));
    await dispatch.tick();
    assert.equal(f.state.launches, 1);
    assert.equal((await f.entries())[0].status, "cancelled");
  } finally { await f.close(); }
});

test("an API lost before launch can reclaim its reservation; an execution already started is never replayed", async () => {
  for (const started of [false, true]) {
    const f = await fixture();
    try {
      await f.recreate()(REQUEST);
      await f.queueStore.withLock(QUEUE, async () => {
        const entry = (await f.queueStore.list(QUEUE))[0];
        await f.queueStore.save(QUEUE, { ...entry, status: "dispatching", owner_pid: -1, token: "OLD-PROCESS" });
      });
      if (started) f.store.beginExecution(TICKET.id, { executionId: "RUN-ALREADY-STARTED", basis: f.registry.get(TICKET.sprint_id), expectedVersion: f.store.get(TICKET.id).version, dependencyExpectations: [] });
      const replacement = f.recreate(); f.state.busy = false; f.state.now += 30_000;
      await replacement.tick(); await settled(f, started ? "superseded" : "completed");
      assert.equal(f.state.launches, started ? 0 : 1);
    } finally { await f.close(); }
  }
});

test("a fixed contract waits for its Coder instead of switching to a different available profile", async () => {
  const f = await fixture();
  try {
    const ticket = { ...TICKET, execution_contract: { coder: "CODER" } };
    const alternate = { agent_id: "ALTERNATE", enabled: true, role: "coder", provider: "codex", status: "ready" };
    const resolver = { list: () => [...f.resolver.list(), alternate], resolveAvailable: () => alternate };
    await assert.rejects(selectTicketCoder({ resolver, occupancy: f.occupancy, ticket, taskId: ticket.id, ownerId: "SUP", payload: {} }), { code: "AGENT_BUSY", not_started: true });
    f.state.enabled = false;
    await assert.rejects(selectTicketCoder({ resolver, occupancy: f.occupancy, ticket, taskId: ticket.id, ownerId: "SUP", payload: {} }), { code: "AGENT_NOT_AVAILABLE" });
  } finally { await f.close(); }
});

test("Sprint DAG waits for the actual queued launch identity and observes Stop without hanging", async () => {
  for (const stop of [false, true]) {
    const f = await fixture();
    try {
      let notify;
      const queued = new Promise((resolve) => { notify = resolve; });
      const dispatch = f.recreate({ projectLogger: (entry) => { if (entry.event_name === "ticket.run_wait_scheduled") notify(); } });
      const runner = createSprintDagRunner({ ticketStatusStore: f.store, sprintRegistry: f.registry,
        eventBus: createExecutionEventBus(), dispatchTask: async ({ ticket, sprintBasis, dependencyExpectations }) => {
          const result = await dispatch({ projectId: PROJECT, ticketId: ticket.id, expectedSprintVersion: sprintBasis.version, dependencyExpectations });
          return result.queued ? dispatch.waitForLaunch(result.wait_id) : result;
        } });
      f.state.onLaunch = async (input) => f.store.updateStatus(TICKET.id, "done", { reason: "fixture_completed" }, { expectedExecutionId: input.executionId });
      const run = runner.runSprintLevels({ projectId: PROJECT, sprintId: TICKET.sprint_id, levels: [[TICKET]], sprintBasis: f.registry.get(TICKET.sprint_id) });
      const result = stop ? assert.rejects(run, { code: "TICKET_STOPPED" }) : run;
      await queued;
      if (stop) await dispatch.stop(REQUEST);
      else { f.state.busy = false; f.state.now += 30_000; await dispatch.tick(); }
      await result;
      assert.equal(f.state.launches, stop ? 0 : 1);
      assert.equal(f.store.get(TICKET.id).status, stop ? "pending" : "done");
    } finally { await f.close(); }
  }
});

test("ticket replacement during reserved intake cannot be adopted as the original queued RUN", async () => {
  const f = await fixture();
  try {
    let replace = false;
    const dispatch = f.recreate({ intake: { open: async () => {
      if (replace) { f.store.updateStatus(TICKET.id, "blocked"); f.store.updateStatus(TICKET.id, "pending"); }
      return { ticket: structuredClone(TICKET) };
    } } });
    await dispatch(REQUEST);
    replace = true; f.state.busy = false; f.state.now += 30_000;
    await dispatch.tick();
    const entry = await settled(f, "failed");
    assert.equal(entry.error.code, "STATUS_CONFLICT");
    assert.equal(f.state.launches, 0);
    assert.deepEqual(f.state.clears, []);
  } finally { await f.close(); }
});
