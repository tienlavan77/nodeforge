// Reproduces an API restart after a timed-out Coder left a running ticket and retained launch.
// Real persistent stores verify that repair exposes Resume without replaying provider work.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDispatchStorage, openDispatchStorage, PROJECT, TICKET } from "../fixtures/ticket-dispatch-recovery-fixture.mjs";
import { createProductionSupervisorRuntime } from "../../src/modules/supervisor/production-runtime.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";

// Seeds a genuine claimed handoff and the legacy gateway timeout at Coder turn 125.
async function fixture(context, { active = false, stale = false, retryFailedTickets = false, provider = "codex" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sdk-timeout-recovery-"));
  await initializeDispatchStorage(root);
  const f = await openDispatchStorage(root);
  if (retryFailedTickets) f.store = createTicketStatusStore({ database: f.database, projectId: PROJECT, retryFailedTickets });
  const events = []; const released = []; let probes = 0;
  const occupancy = { listActive: () => released.length ? [] : [{ claim_id: "CLAIM", task_id: TICKET.id, supervisor_id: `SUP-${TICKET.id}`, project_id: PROJECT }],
    release: async (input) => { released.push(input); } };
  const runtime = createProductionSupervisorRuntime({ fileService: f.files, projectId: PROJECT, projectRoot: root, root: "recovery",
    ticketStatusStore: f.store, sprintRegistry: f.registry, agentOccupancy: occupancy, autoStartWorkers: false,
    [provider === "claude" ? "claudeSdkGateway" : "codexSdkGateway"]: { assertSessionStopped: () => { probes++; if (active) throw Object.assign(new Error("Still running"), { code: "EXECUTION_SESSION_BUSY" }); },
      execute: () => assert.fail("Recovery must wait for explicit Resume") },
    logger: { info() {}, debug() {}, warn() {}, error: console.error }, gitService: { status: async () => "" } });
  runtime.eventBus.subscribe("*", (event) => events.push(event));
  context.after(async () => {
    runtime.senderWorker.stop(); runtime.collectorWorkerLoop.stop(); runtime.verificationWorkerLoop.stop();
    await f.database.close(); await rm(root, { recursive: true, force: true });
  });
  const basis = f.registry.get(TICKET.sprint_id);
  f.store.beginExecution(TICKET.id, { executionId: "RUN-TIMEOUT", basis, expectedVersion: f.store.get(TICKET.id).version, dependencyExpectations: [] });
  const request = { task_id: TICKET.id, project_id: PROJECT, request_id: "BLOCKER-RESUME-JOB", correlation_id: "CORR", ticket: TICKET,
    payload: { execution_id: "RUN-TIMEOUT", sprint_basis: basis, dependency_expectations: [] } };
  const queued = await runtime.queues["sender.handoff"].enqueue(request);
  const receipt = f.store.claimExecutionLaunch(TICKET.id, { executionId: "RUN-TIMEOUT", basis, requestId: request.request_id,
    jobId: queued.id, supervisorId: `SUP-${TICKET.id}`, agentId: "CODER", claimId: "CLAIM", validate: () => {} });
  const checkpoint = { task_id: TICKET.id, correlation_id: "CORR", provider, agent_id: "CODER", thread_id: "THREAD", session_id: "SESSION",
    status: "blocked", phase: "blocker_resolved", last_completed_turn: 125, changed_paths: ["ui/nextjs/components/ideas-panel.jsx"],
    failure_request_id: "OLDER-BLOCKER", blocker_recovery: { job_id: "JOB", status: "resolved", disposition: { action: "resolved", guidance: "Implement approved UI" } },
    failure: { code: "CONFIGURATION_ERROR", message: `${provider === "claude" ? "Claude" : "Codex"} SDK request timed out for CODER.`,
      at: new Date(Date.parse(receipt.claimed_at) + (stale ? -1000 : 1000)).toISOString() } };
  await runtime.agentCheckpoints.save(checkpoint);
  await runtime.queueStore.save("blocker.recovery", { id: "LEDGER", project_id: PROJECT, task_id: TICKET.id, execution_id: "RUN-TIMEOUT",
    jobs: [{ id: "JOB", status: "reconciliation_required", resolution: { action: "resolved" }, history: ["retained"] }] });
  await runtime.stateStore.save({ task_id: TICKET.id, supervisor_id: `SUP-${TICKET.id}`, state: "RUNNING", pending_request: request, updated_at: new Date().toISOString() });
  return { ...f, runtime, events, released, checkpoint, receipt, get probes() { return probes; } };
}

test("restart repairs a legacy timeout and exposes failure without replaying a resolved SL handoff", async (context) => {
  const f = await fixture(context);
  await f.runtime.recover();
  const current = f.store.get(TICKET.id);
  assert.equal(current.status, "failed");
  assert.match(current.error, /timed out/);
  assert.equal(current.details.launch_claim, null);
  const checkpoint = await f.runtime.agentCheckpoints.load(TICKET.id);
  assert.equal(checkpoint.status, "failed");
  assert.equal(checkpoint.failure.code, "SDK_REQUEST_TIMEOUT");
  assert.equal(checkpoint.failure.resume_allowed, true);
  assert.equal(checkpoint.thread_id, "THREAD");
  assert.equal(checkpoint.last_completed_turn, 125);
  assert.deepEqual(checkpoint.changed_paths, f.checkpoint.changed_paths);
  assert.deepEqual(checkpoint.blocker_recovery, f.checkpoint.blocker_recovery);
  assert.equal((await f.runtime.queueStore.list("blocker.recovery"))[0].jobs[0].status, "resumed");
  assert.equal(f.events.filter((event) => event.type === "task.failed").length, 1);
  await f.runtime.recover();
  assert.equal(f.events.filter((event) => event.type === "task.failed").length, 1);
  assert.deepEqual(await f.runtime.queueStore.list("agent.request"), []);
});

test("restart settles a Claude timeout at the saved session without invoking Coder or Reviewer", async (context) => {
  const f = await fixture(context, { provider: "claude" });
  await f.runtime.recover();
  assert.equal(f.store.get(TICKET.id).details.launch_claim, null);
  const checkpoint = await f.runtime.agentCheckpoints.load(TICKET.id);
  assert.equal(checkpoint.failure.resume_allowed, true);
  assert.equal(checkpoint.session_id, "SESSION");
  assert.equal(checkpoint.last_completed_turn, 125);
  assert.equal(f.released.length > 0, true);
  await f.runtime.recover();
  assert.equal(f.events.filter((event) => event.type === "task.failed").length, 1);
});

for (const options of [{ active: true }, { stale: true }]) {
  test(`restart preserves ownership for ${options.active ? "an active runner" : "a timeout older than the current launch"}`, async (context) => {
    const f = await fixture(context, options);
    await f.runtime.recover();
    assert.equal(f.store.get(TICKET.id).status, "running");
    assert.deepEqual(f.store.get(TICKET.id).details.launch_claim, f.receipt);
    assert.equal(f.events.length, 0);
    assert.equal(f.released.length, 0);
  });
}

test("production retry-ready status waits for manual Resume across repeated startup recovery", async (context) => {
  const f = await fixture(context, { retryFailedTickets: true });
  await f.runtime.recover();
  assert.equal(f.store.get(TICKET.id).status, "pending");
  assert.match(f.store.get(TICKET.id).details.last_failure.error, /timed out/);
  assert.equal((await f.runtime.agentCheckpoints.load(TICKET.id)).failure.resume_allowed, true);
  await f.runtime.recover();
  assert.equal(f.events.filter((event) => event.type === "task.failed").length, 1);
  assert.deepEqual(await f.runtime.queueStore.list("agent.request"), []);
});

test("restart completes a partially persisted timeout settlement without losing its checkpoint", async (context) => {
  const f = await fixture(context);
  await f.runtime.agentCheckpoints.save({ ...f.checkpoint, status: "failed", phase: "sdk_timeout", failure_request_id: f.receipt.request_id,
    failure: { ...f.checkpoint.failure, code: "SDK_REQUEST_TIMEOUT", resume_allowed: true } });
  f.store.reconcileExecutionLaunch(TICKET.id, { executionId: f.receipt.execution_id, requestId: f.receipt.request_id, jobId: f.receipt.job_id, disposition: "executor_failed" });
  await f.runtime.recover();
  assert.equal(f.store.get(TICKET.id).status, "failed");
  assert.equal((await f.runtime.agentCheckpoints.load(TICKET.id)).last_completed_turn, 125);
  assert.equal(f.events.filter((event) => event.type === "task.failed").length, 1);
});
