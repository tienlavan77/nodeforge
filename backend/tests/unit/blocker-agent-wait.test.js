// Exercises durable busy-Coder scheduling through production resume gates, preserving decisions and checkpoints across retries and restarts.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { selectTicketCoder } from "../../src/modules/supervisor/ticket-agent-provider-routing.js";

// Retains the exact Coder identity while another ticket owns its durable occupancy claim.
async function waitingFixture() {
  const f = await blockerRecoveryFixture({ investigate: async (_job, resolution) => resolution });
  await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
  await f.base.checkpoints.save({ ...await f.base.checkpoints.load("TASK"), last_completed_turn: 36,
    thread_id: "RETAINED-THREAD", report_draft: { commit_sha: "COMMIT", artifact_id: "PASS-ARTIFACT" } });
  let busy = true;
  let enabled = true;
  const options = {
    agentResolver: { list: () => [{ agent_id: "CODER", role: "coder", provider: "codex", enabled, status: busy ? "working" : "ready" }] },
    agentOccupancy: { ...f.base.occupancy, listActive: () => busy ? [{ claim_id: "OTHER-CLAIM", agent_id: "CODER", task_id: "OTHER", supervisor_id: "SUP-OTHER", project_id: "P" }] : [] }
  };
  f.recreate(options);
  return { f, options, release: () => { busy = false; }, disable: () => { enabled = false; } };
}

test("busy Coder waits 30 seconds across restart then resumes once without SL/AM replay", async () => {
  const { f, options, release } = await waitingFixture();
  try {
    const checkpoint = await f.base.checkpoints.load("TASK");
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs.at(-1).status, "resume_pending");
    await f.recovery.tick();
    let job = (await f.ledger()).jobs.at(-1);
    assert.equal(job.outcome_reason, "AGENT_BUSY");
    assert.equal(job.resolution.action, "resolved");
    assert.equal(job.agent_wait.busy_task_id, "OTHER");
    await f.recovery.tick();
    assert.equal(f.base.statusStore.get().status, "pending");
    const waiting = await f.base.checkpoints.load("TASK");
    for (const field of ["last_completed_turn", "completed_tools", "failure", "agent_id", "thread_id", "report_draft", "changed_paths"])
      assert.deepEqual(waiting[field], checkpoint[field]);
    assert.equal(waiting.blocker_recovery.disposition.action, "resolved");
    f.recreate(options);
    release();
    f.advance(29_999);
    assert.equal(await f.recovery.tick(), null);
    assert.equal(f.base.invocations, 1);
    f.advance(1);
    await f.recovery.tick();
    job = (await f.ledger()).jobs.at(-1);
    assert.equal(job.status, "resumed");
    assert.equal(f.base.invocations, 2);
    assert.deepEqual(f.calls, ["sprint_leader"]);
    assert.equal(f.base.statusStore.get().status, "done");
    assert.equal(await f.recovery.tick(), null);
  } finally { await f.close(); }
});

test("long occupancy does not exhaust triage deadline or grow consultation history", async () => {
  const { f } = await waitingFixture();
  try {
    await f.recovery.tick();
    await f.recovery.tick();
    await f.recovery.tick();
    const history = (await f.ledger()).jobs.at(-1).history;
    f.advance(700_000);
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs.at(-1).outcome_reason, "AGENT_BUSY");
    assert.deepEqual((await f.ledger()).jobs.at(-1).history, history);
    assert.deepEqual(f.calls, ["sprint_leader"]);
    assert.equal(f.base.invocations, 1);
  } finally { await f.close(); }
});

test("Stop cancels waiting work; release never restarts Coder automatically", async () => {
  const { f, release } = await waitingFixture();
  try {
    await f.recovery.tick(); await f.recovery.tick(); await f.recovery.tick();
    await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
    release(); f.advance(30_000);
    assert.equal(await f.recovery.tick(), null);
    assert.equal((await f.ledger()).cancelled, true);
    assert.equal(f.base.invocations, 1);
  } finally { await f.close(); }
});

test("source replacement cancels a queued Coder resume", async () => {
  const { f, release } = await waitingFixture();
  try {
    await f.recovery.tick(); await f.recovery.tick(); await f.recovery.tick();
    f.base.staleSource(); release(); f.advance(30_000);
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs.at(-1).outcome_reason, "stale_execution_or_source");
    assert.equal(f.base.invocations, 1);
  } finally { await f.close(); }
});

test("disabled Coder is an availability fault and cannot stay in a busy retry", async () => {
  const { f, release, disable } = await waitingFixture();
  try {
    await f.recovery.tick(); await f.recovery.tick(); await f.recovery.tick();
    disable(); release(); f.advance(30_000);
    await f.recovery.tick();
    const job = (await f.ledger()).jobs.at(-1);
    assert.equal(job.outcome_reason, "AGENT_NOT_AVAILABLE");
    assert.equal(job.agent_wait, undefined);
    assert.equal(job.status, "notification_pending");
    assert.equal(f.base.invocations, 1);
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs.at(-1).status, "reconciliation_required");
    assert.equal((await f.base.checkpoints.load("TASK")).blocker_recovery.reason, "AGENT_NOT_AVAILABLE");
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs.at(-1).status, "reconciliation_required");
  } finally { await f.close(); }
});

test("old unavailable dispatch retains resolved decision instead of calling SL again", async () => {
  const { f, release } = await waitingFixture();
  try {
    await f.recovery.tick();
    const ledger = await f.ledger();
    Object.assign(ledger.jobs.at(-1), { status: "reconciliation_required", outcome_reason: "AGENT_NOT_AVAILABLE" });
    await f.base.store.save("blocker.recovery", ledger);
    release(); f.advance(700_000);
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs.at(-1).status, "resumed");
    assert.deepEqual(f.calls, ["sprint_leader"]);
  } finally { await f.close(); }
});

test("atomic claim race is classified as busy only with a concrete competing claim", async () => {
  let occupied = false;
  const profile = { agent_id: "CODER", role: "coder", provider: "codex", enabled: true, status: "ready" };
  const input = { resolver: { list: () => [profile] }, ticket: { execution_contract: { coder: "CODER" } },
    taskId: "TASK", ownerId: "SUP", payload: {}, occupancy: { getByTask: () => null,
      listActive: () => occupied ? [{ claim_id: "CLAIM", agent_id: "CODER", task_id: "OTHER" }] : [],
      claim: async () => { occupied = true; return null; } } };
  await assert.rejects(selectTicketCoder(input), { code: "AGENT_BUSY", not_started: true });
  profile.enabled = false;
  await assert.rejects(selectTicketCoder(input), { code: "AGENT_NOT_AVAILABLE" });
  profile.enabled = true;
  input.occupancy.listActive = () => [];
  await assert.rejects(selectTicketCoder(input), { code: "AGENT_NOT_AVAILABLE" });
});

test("claim race during submit rolls back an unlaunched attempt then queues the original checkpoint", async () => {
  const { f, options, release } = await waitingFixture();
  try {
    release();
    f.recreate({ ...options, submitTicket: async () => { throw Object.assign(new Error("Busy at claim"), {
      code: "AGENT_BUSY", not_started: true, agent_wait: { agent_id: "CODER", claim_id: "RACING-CLAIM", busy_task_id: "OTHER" } }); } });
    await f.recovery.tick(); await f.recovery.tick(); await f.recovery.tick();
    assert.equal(f.base.statusStore.get().status, "pending");
    const checkpoint = await f.base.checkpoints.load("TASK");
    assert.equal(checkpoint.last_completed_turn, 36);
    assert.equal(checkpoint.thread_id, "RETAINED-THREAD");
    assert.equal(checkpoint.blocker_recovery.reason, "AGENT_BUSY");
    assert.equal(f.base.invocations, 1);
    f.recreate(options); f.advance(30_000);
    await Promise.all([f.recovery.tick(), f.recovery.tick()]);
    assert.equal(f.base.invocations, 2);
    assert.equal((await f.ledger()).jobs.at(-1).status, "resumed");
  } finally { await f.close(); }
});

test("failed wait notification is redelivered after restart without losing the scheduling receipt", async () => {
  const { f, options } = await waitingFixture();
  try {
    await f.recovery.tick(); await f.recovery.tick();
    const deadline = (await f.ledger()).jobs.at(-1).agent_wait.available_at;
    const original = f.base.eventBus.publish;
    f.base.eventBus.publish = async () => { throw new Error("Stream unavailable"); };
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs.at(-1).agent_wait.notified, false);
    f.base.eventBus.publish = original;
    f.recreate(options); await f.recovery.tick();
    const wait = (await f.ledger()).jobs.at(-1).agent_wait;
    assert.equal(wait.notified, true);
    assert.equal(wait.available_at, deadline);
    assert.equal(f.base.invocations, 1);
  } finally { await f.close(); }
});
