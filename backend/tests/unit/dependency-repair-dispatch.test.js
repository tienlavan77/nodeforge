// Exercises dependency repairs through the shared RUN dispatcher, durable busy queue and hard-review payload.
// These tests use actual status, checkpoint and queue storage while replacing only provider execution.
import assert from "node:assert/strict";
import test from "node:test";
import { dependencyRepairFixture, waitForDependency } from "../fixtures/dependency-repair-fixture.js";
import { createDependencyRepairCoordinator } from "../../src/modules/supervisor/coder/dependency-repair-coordinator.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";
import { createApprovedTicketDispatch } from "../../src/application/approved-ticket-dispatch.js";
import { createBlockerRecovery } from "../../src/modules/supervisor/blocker/blocker-recovery.js";
import { automaticReviewPolicy } from "../../src/modules/supervisor/review/automatic-review-identity.js";
import { beginAutomaticReview } from "../../src/modules/supervisor/review/automatic-review-stage.js";
import { reviewRevisionResume } from "../../src/modules/supervisor/review/review-revision-resume.js";

// Connects real normal RUN and approved dispatch, controlling only Coder availability and SDK completion.
function dispatcher(f) {
  let busy = true;
  const submitted = [];
  const profile = { agent_id: "CODER", provider: "claude", role: "coder", enabled: true, status: "ready" };
  const run = createTicketRunDispatch({ projectId: "P", ticketStatusStore: f.statuses, sprintRegistry: f.registry, queueStore: f.store,
    checkpoints: f.checkpoints, disposition: f.services.disposition, intake: { open: async ({ ticketId }) => ({ ticket: f.specs.find((ticket) => ticket.id === ticketId) }) },
    agentResolver: { list: () => [profile] }, agentOccupancy: { listActive: () => busy ? [{ agent_id: "CODER", claim_id: "BUSY", task_id: "OTHER", supervisor_id: "SUP-OTHER" }] : [] },
    protocolStorage: { clearTask: async () => assert.fail("Repair must preserve protocol history") },
    conversationStateStore: { clear: async () => assert.fail("Repair must preserve conversation") }, clock: () => f.state.now, projectLogger: () => {},
    dispatchTask: createApprovedTicketDispatch({ projectId: "P", ticketStatusStore: f.statuses, sprintRegistry: f.registry,
      integration: { submitTicket: async (input) => { submitted.push(input); return { status: "accepted" }; } } }) });
  return { run, submitted, free: () => { busy = false; } };
}

test("a busy dependency Coder queues at the original checkpoint, then resumes with its own mandatory review cycle", async (t) => {
  const f = await dependencyRepairFixture(t);
  const d = dispatcher(f); t.after(() => d.run.close());
  const coordinator = createDependencyRepairCoordinator({ ...f.services, dispatchTicket: d.run });
  const id = await coordinator.request(f.job, f.value); f.job.dependency_request_id = id;
  await f.store.save("blocker.recovery", { id: "LEDGER", task_id: "PARENT", project_id: "P", execution_id: "RUN-PARENT", jobs: [f.job] });
  await coordinator.tick();
  const entry = await waitForDependency(f, (entry) => entry?.dispatch_result?.queued);
  assert.equal(f.statuses.get("UP").status, "pending");
  assert.equal(d.submitted.length, 0);
  assert.equal(entry.dispatch_result.agent_wait.interval_ms, 30000);
  assert.equal((await f.checkpoints.load("UP")).last_completed_turn, 36);
  await coordinator.tick(); assert.equal(await coordinator.refresh(f.job), false);
  d.free(); f.state.now += 30000; await d.run.tick();
  for (let index = 0; index < 300 && !d.submitted.length; index++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(d.submitted.length, 1);
  for (let index = 0; index < 300; index++) {
    const entries = await f.store.withLock("ticket.run-agent-wait", () => f.store.list("ticket.run-agent-wait"));
    if (entries[0]?.status === "completed") break;
    if (index === 299) assert.fail("RUN wait did not finish settling");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const request = d.submitted[0];
  assert.equal(request.payload.resume_from.session_id, "SDK-SESSION");
  assert.equal(request.payload.review_cycle_id, id);
  assert.equal(request.payload.execution_id, "RUN-UP");
  assert.equal(f.statuses.get("UP").status, "running");
  assert.equal(automaticReviewPolicy({ execution_policy: { review_gate: "off" } }, { blocking: Boolean(request.payload.review_cycle_id) }).gate, "on");
  f.statuses.updateStatus("UP", "reviewing", { reason: "normal_pipeline_transition" });
  assert.equal(f.statuses.get("UP").details.dependency_repair.id, id);
});

test("parent Stop prevents a queued repair from starting after Coder availability returns", async (t) => {
  const f = await dependencyRepairFixture(t);
  const d = dispatcher(f); t.after(() => d.run.close());
  const coordinator = createDependencyRepairCoordinator({ ...f.services, dispatchTicket: d.run });
  f.job.dependency_request_id = await coordinator.request(f.job, f.value);
  await f.store.save("blocker.recovery", { id: "LEDGER", task_id: "PARENT", project_id: "P", execution_id: "RUN-PARENT", jobs: [f.job] });
  await coordinator.tick(); await waitForDependency(f, (entry) => entry?.dispatch_result?.queued);
  f.state.cancelled.add("PARENT"); d.free(); f.state.now += 30000;
  await d.run.tick();
  for (let index = 0; index < 300; index++) {
    const entries = await f.store.withLock("ticket.run-agent-wait", () => f.store.list("ticket.run-agent-wait"));
    if (entries[0]?.status === "failed") {
      assert.equal(entries[0].error.code, "DEPENDENCY_REPAIR_CANCELLED");
      break;
    }
    if (index === 299) assert.fail("Stopped dependency RUN was not cancelled");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(d.submitted.length, 0);
  assert.equal((await f.checkpoints.load("UP")).last_completed_turn, 36);
});

test("new repair review replaces only its prior approved cycle and ignores old Coder finding handoffs", async (t) => {
  const f = await dependencyRepairFixture(t);
  const id = await f.request(); await f.coordinator.tick();
  await waitForDependency(f, (entry) => entry?.dispatch_result);
  const coder = await f.checkpoints.load("UP");
  await f.store.save("sender.handoff", { id: "OLD-REPAIR", task_id: "UP", payload: { review_cycle_id: "OLD-CYCLE", review_findings: [{ id: "REV-1" }] } });
  assert.deepEqual(await reviewRevisionResume(f.store, "UP", coder), coder);
  const current = f.statuses.get("UP");
  f.statuses.resumeReviewExecution("UP", { expectedVersion: current.version, executionId: "RUN-UP", basis: f.basis, dependencyExpectations: current.details.dependency_expectations, validate: () => {} });
  const context = await f.contexts.load("UP");
  await beginAutomaticReview({ task_id: "UP", project_id: "P", request_id: "NEW-REVIEW", review_policy: { gate: "on" }, payload: {
    execution_id: "RUN-UP", sprint_basis: f.basis, execution_context: context, commit: "c".repeat(40), verification: { artifact_id: "ARTIFACT-NEW" } } }, f.statuses, f.checkpoints);
  const review = await f.checkpoints.loadReview("UP");
  assert.equal(review.request_id, "NEW-REVIEW"); assert.equal(review.status, "in_progress");
  assert.equal(review.execution_context.review_repair_cycle_id, id);
  await f.checkpoints.saveReview({ task_id: "UP", request_id: "OLD-REVIEW", status: "completed", verdict: "approved", execution_context: f.context });
  assert.equal((await f.checkpoints.loadReview("UP")).request_id, "NEW-REVIEW");
});

test("parent waits without AM calls or deadline expiry and resumes SL exactly once on new dependency evidence", async (t) => {
  const f = await dependencyRepairFixture(t);
  const id = await f.request();
  const ledger = (await f.store.list("blocker.recovery"))[0]; ledger.deadline_at = 1000; ledger.calls = 0; ledger.resumes = 0;
  await f.store.save("blocker.recovery", ledger);
  const roles = [];
  const recovery = createBlockerRecovery({ store: f.store, clock: () => f.state.now, validate: async () => true,
    investigate: async (job) => { roles.push(job.stage); assert.equal(job.dependency_result.result.review, "approved"); return { action: "resolved", summary: "Continue after accepted repair." }; },
    checkDisposition: async (value) => value, resume: async () => {}, notify: async () => assert.fail("Dependency wait must not notify Owner"),
    refreshWaiting: f.coordinator.refresh });
  f.state.now += 600000;
  for (let index = 0; index < 3; index++) await recovery.tick();
  assert.deepEqual(roles, []);
  await f.coordinator.tick(); await waitForDependency(f, (entry) => entry?.dispatch_result);
  await f.complete(id); await f.coordinator.tick();
  await recovery.tick(); assert.deepEqual(roles, ["sprint_leader"]);
  await recovery.tick(); await recovery.tick(); assert.deepEqual(roles, ["sprint_leader"]);
  assert.equal((await f.store.list("blocker.recovery"))[0].jobs[0].status, "resumed");
});

test("accepted SL decision survives a restart between intent persistence and parent wait without another provider call", async (t) => {
  const f = await dependencyRepairFixture(t);
  const ledger = (await f.store.list("blocker.recovery"))[0];
  ledger.jobs[0].status = "pending"; ledger.calls = 0; ledger.resumes = 0; ledger.deadline_at = f.state.now + 60000;
  await f.store.save("blocker.recovery", ledger);
  let calls = 0;
  const options = { store: f.store, clock: () => f.state.now, validate: async () => true,
    investigate: async () => { calls++; return f.value; }, checkDisposition: async (value) => value,
    requestDependency: f.coordinator.request, refreshWaiting: f.coordinator.refresh, resume: async () => {}, notify: async () => assert.fail("No Owner question is required") };
  await createBlockerRecovery(options).tick();
  const accepted = (await f.store.list("blocker.recovery"))[0].jobs[0];
  assert.equal(accepted.status, "dependency_request_pending");
  const id = await f.coordinator.request(accepted, accepted.resolution);
  await createBlockerRecovery(options).tick();
  assert.equal((await f.store.list("blocker.recovery"))[0].jobs[0].dependency_request_id, id);
  await f.coordinator.tick(); await waitForDependency(f, (entry) => entry?.dispatch_result);
  assert.equal(calls, 1); assert.equal(f.state.launches.length, 1);
});

test("partial journal preparation retries at 30s and finishes safely after parent Stop without launching", async (t) => {
  const f = await dependencyRepairFixture(t);
  const id = await f.request();
  let interrupted = true;
  const coordinator = createDependencyRepairCoordinator({ ...f.services, checkpoints: { ...f.checkpoints, save: async (checkpoint) => {
    if (checkpoint.task_id === "UP" && interrupted) { interrupted = false; throw Object.assign(new Error("checkpoint write interrupted"), { code: "EIO" }); }
    return f.checkpoints.save(checkpoint);
  } } });
  await coordinator.tick();
  const entry = await waitForDependency(f, (entry) => entry?.error?.code === "EIO");
  assert.equal(entry.status, "queued"); assert.equal(entry.available_at, f.state.now + 30000);
  assert.equal(f.statuses.get("UP").details.dependency_repair.state, "preparing");
  assert.equal(f.state.launches.length, 0);
  f.state.cancelled.add("PARENT"); f.state.now += 30000;
  await coordinator.tick();
  assert.equal(f.statuses.get("UP").details.dependency_repair.state, "ready");
  assert.equal((await f.checkpoints.load("UP")).review_cycle_id, id);
  assert.equal((await f.store.list("ticket.dependency-repair"))[0].status, "cancelled");
  assert.equal(f.state.launches.length, 0);
});

test("historical review completion cannot replay across a dependency repair reservation", async (t) => {
  const f = await dependencyRepairFixture(t);
  const id = await f.request(); await f.coordinator.tick();
  await waitForDependency(f, (entry) => entry?.dispatch_result);
  const { isCompletedReviewReopened } = await import("../../src/modules/supervisor/review/completed-review-resume.js");
  const old = { id: "OLD-REVIEW", task_id: "UP", payload: { execution_id: "RUN-UP" } };
  assert.equal(isCompletedReviewReopened(old, f.statuses), true);
  assert.equal(isCompletedReviewReopened({ ...old, id: "NEW-REVIEW", payload: { ...old.payload, review_cycle_id: id } }, f.statuses), false);
  await f.complete(id);
  assert.equal(isCompletedReviewReopened(old, f.statuses), true);
});

test("Stop then Resume retains SL's accepted dependency request without another consultation", async (t) => {
  const f = await dependencyRepairFixture(t);
  const ledger = (await f.store.list("blocker.recovery"))[0];
  ledger.jobs[0].status = "pending"; ledger.calls = 0; ledger.resumes = 0; ledger.deadline_at = f.state.now + 60000;
  await f.store.save("blocker.recovery", ledger);
  let calls = 0;
  const recovery = createBlockerRecovery({ store: f.store, clock: () => f.state.now, validate: async () => true,
    investigate: async () => { calls++; return f.value; }, checkDisposition: async (value) => value,
    requestDependency: f.coordinator.request, refreshWaiting: f.coordinator.refresh, resume: async () => {}, notify: async () => assert.fail("No Owner decision is required") });
  await recovery.tick(); await recovery.tick();
  const identity = { projectId: "P", taskId: "PARENT", executionId: "RUN-PARENT" };
  await recovery.cancel(identity); f.state.now += 30000; await f.coordinator.tick();
  assert.equal((await f.store.list("ticket.dependency-repair"))[0].status, "cancelled");
  const resumed = await recovery.resumeStage(identity);
  assert.equal(resumed.status, "dependency_request_pending");
  await recovery.tick(); await f.coordinator.tick();
  await waitForDependency(f, (entry) => entry?.dispatch_result);
  assert.equal(calls, 1); assert.equal(f.state.launches.length, 1);
  assert.equal((await f.checkpoints.load("PARENT")).last_completed_turn, 19);
});
