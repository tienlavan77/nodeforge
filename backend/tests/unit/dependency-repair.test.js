// Verifies approved dependency execution produces new evidence without replaying AM, losing checkpoints or changing ticket scope.
import assert from "node:assert/strict";
import test from "node:test";
import { dependencyRepairFixture, waitForDependency } from "../fixtures/dependency-repair-fixture.js";
import { createDependencyRepairCoordinator } from "../../src/modules/supervisor/coder/dependency-repair-coordinator.js";
import { createFileQueueStore } from "../../src/modules/supervisor/file-queue-store.js";
import { inspectDependencyRequest, assertDependencyRepairDispatch } from "../../src/modules/supervisor/coder/dependency-repair-contract.js";
import { reserveDependencyRepair, saveDependencyRepair } from "../../src/modules/supervisor/coder/dependency-repair-queue.js";
import { createResumeState, buildResumePrompt } from "../../src/modules/supervisor/ticket/ticket-resume.js";

const QUEUE = "ticket.dependency-repair";

test("SL repair retains both checkpoints, archives integrated evidence and needs new independent acceptance", async (t) => {
  const f = await dependencyRepairFixture(t);
  const parent = await f.checkpoints.load("PARENT");
  const id = await f.request();
  assert.equal(await f.request(), id);
  assert.equal((await f.store.list(QUEUE)).length, 1);
  assert.equal(f.statuses.get("PARENT").status, "pending");
  assert.equal(await f.coordinator.refresh(f.job), false);
  await f.coordinator.tick();
  const entry = await waitForDependency(f, (entry) => entry?.dispatch_result);
  const coder = await f.checkpoints.load("UP");
  assert.equal(coder.last_completed_turn, 36);
  assert.equal(coder.session_id, "SDK-SESSION");
  assert.equal(coder.review_cycle_id, id);
  assert.equal(coder.dependency_repair.instructions, f.value.dependency_request.instructions);
  assert.equal(coder.review_findings, undefined);
  assert.equal(f.statuses.get("UP").details.execution_id, "RUN-UP");
  assert.deepEqual(await f.checkpoints.load("PARENT"), parent);
  assert.equal(await f.files.readFile({ path: "source.js" }), "unrelated source stays intact\n");
  const receipt = JSON.parse(await f.files.readFile({ path: f.statuses.get("UP").details.dependency_repair.receipt }));
  assert.equal(receipt.context.state, "terminal");
  assert.equal(receipt.context.review_commit_sha, f.context.review_commit_sha);
  assert.equal(f.state.launches[0].expectedExecutionBasis.plan_id, "PLAN");
  assert.equal(f.state.launches[0].dependencyRepair.id, id);
  assert.match(buildResumePrompt("Task", createResumeState(coder)), /SPRINT DEPENDENCY REPAIR/);
  assert.match(buildResumePrompt("Task", createResumeState(coder)), /Repair the saved indicator/);
  assert.equal(await f.coordinator.refresh(f.job), false);
  await f.complete(id);
  assert.equal((await f.checkpoints.loadReview("UP")).request_id, `REVIEW-${id}`);
  const replacement = createDependencyRepairCoordinator({ ...f.services, store: createFileQueueStore({ fileService: f.files }) });
  await replacement.tick();
  assert.equal(await f.coordinator.refresh(f.job), true);
  assert.equal(f.job.dependency_result.result.commit_sha, "c".repeat(40));
  assert.equal(f.job.dependency_result.result.review, "approved");
  f.job.status = "pending";
  assert.equal(await f.coordinator.refresh(f.job), false);
  await replacement.tick(); assert.equal(f.state.launches.length, 1);
  assert.equal(entry.target.execution_id, "RUN-UP");
  assert.deepEqual(await f.store.pruneTerminal(QUEUE, { now: Date.now() + 172800000 }), { removed: 0 });
});

test("upstream authorization rejects unrelated tickets, self, cycles, other projects and changed execution basis", async (t) => {
  const f = await dependencyRepairFixture(t);
  const inspect = () => inspectDependencyRequest(f.job, f.value, { sprintRegistry: f.registry, ticketStatusStore: f.statuses });
  assert.equal((await inspect()).ticket.id, "UP");
  for (const id of ["OTHER", "PARENT", "MISSING"]) {
    f.value.dependency_request.ticket_id = id;
    await assert.rejects(inspect);
  }
  f.value.dependency_request.ticket_id = "UP";
  f.specs[0].dependencies = ["PARENT"]; await assert.rejects(inspect, /cyclic/);
  f.specs[0].dependencies = []; f.specs[0].project_id = "FOREIGN"; await assert.rejects(inspect, /same project/);
  f.specs[0].project_id = "P"; f.basis.version++; await assert.rejects(inspect, /execution bound/);
});

test("two coordinator instances dispatch a single repair and a launch claim prevents replacement", async (t) => {
  let release;
  const f = await dependencyRepairFixture(t, { dispatch: () => new Promise((resolve) => { release = resolve; }) });
  await f.request();
  const replacement = createDependencyRepairCoordinator({ ...f.services, store: createFileQueueStore({ fileService: f.files }) });
  await Promise.all([f.coordinator.tick(), replacement.tick()]);
  await waitForDependency(f, () => f.state.launches.length === 1);
  await replacement.tick(); assert.equal(f.state.launches.length, 1);
  release({ status: "accepted" }); await waitForDependency(f, (entry) => entry?.dispatch_result);
  const current = f.statuses.get("UP");
  f.statuses.resumeReviewExecution("UP", { executionId: "RUN-UP", basis: f.basis, expectedVersion: current.version, validate: () => {}, dependencyExpectations: current.details.dependency_expectations });
  f.statuses.claimExecutionLaunch("UP", { executionId: "RUN-UP", basis: f.basis, requestId: "SDK", jobId: "SDK-JOB", supervisorId: "SUP-UP", agentId: "CODER", validate: () => {} });
  await replacement.tick(); assert.equal(f.state.launches.length, 1);
  assert.equal((await f.store.withLock(QUEUE, () => f.store.list(QUEUE)))[0].status, "running");
});

test("new process resumes an unlaunched prepared repair, while immutable receipt survives queue-save failure", async (t) => {
  const f = await dependencyRepairFixture(t);
  const save = f.store.save;
  let fail = true;
  const interrupted = createDependencyRepairCoordinator({ ...f.services, store: { ...f.store, save: async (name, entry) => {
    if (name === QUEUE && fail) { fail = false; throw new Error("queue-save crash"); }
    return save(name, entry);
  } } });
  await assert.rejects(interrupted.request(f.job, f.value), /queue-save crash/);
  const id = await f.request();
  assert.equal((await f.store.list(QUEUE)).length, 1);
  await f.coordinator.tick();
  const entry = await waitForDependency(f, (entry) => entry?.dispatch_result);
  await f.store.withLock(QUEUE, () => f.store.save(QUEUE, { ...entry, status: "dispatching", dispatch_result: null, owner: { pid: 2147483647, token: "dead" } }));
  const replacement = createDependencyRepairCoordinator({ ...f.services, store: createFileQueueStore({ fileService: f.files }) });
  await replacement.tick(); await waitForDependency(f, () => f.state.launches.length === 2);
  await waitForDependency(f, (entry) => entry?.dispatch_result);
  assert.equal((await f.checkpoints.load("UP")).review_cycle_id, id);
  assert.equal((await f.checkpoints.load("UP")).last_completed_turn, 36);
});

test("Stop cancels pending dependency intent and stale callbacks cannot restore it", async (t) => {
  const f = await dependencyRepairFixture(t);
  await f.request();
  const entry = (await f.store.list(QUEUE))[0];
  const reserved = await reserveDependencyRepair(f.store, entry, () => f.state.now);
  f.state.cancelled.add("PARENT"); f.state.now += 30000;
  await f.coordinator.tick();
  assert.equal((await f.store.list(QUEUE))[0].status, "cancelled");
  assert.equal(await saveDependencyRepair(f.store, reserved, { status: "running" }, () => f.state.now), null);
  assert.equal(f.state.launches.length, 0);
  assert.equal(await f.coordinator.refresh(f.job), false);
});

test("failure returns its real cause to SL and rejects unchanged request replay", async (t) => {
  const f = await dependencyRepairFixture(t, { dispatch: async () => { throw Object.assign(new Error("runner unavailable"), { code: "ENOENT" }); } });
  await f.request(); await f.coordinator.tick();
  await waitForDependency(f, (entry) => entry?.status === "failed");
  assert.equal(await f.coordinator.refresh(f.job), true);
  assert.equal(f.job.dependency_result.error.code, "ENOENT");
  assert.match(f.job.dependency_result.error.message, /runner unavailable/);
  await assert.rejects(f.coordinator.validate(f.job, f.value), /already failed/);
  f.value.dependency_request.instructions = "Use the restored runner receipt and repair only the missing behavior.";
  assert.equal((await f.coordinator.validate(f.job, f.value)).ticket.id, "UP");
});

test("deferred RUN rechecks parent Stop rather than launching after the Coder becomes free", async (t) => {
  const f = await dependencyRepairFixture(t);
  const id = await f.request(); await f.coordinator.tick();
  await waitForDependency(f, (entry) => entry?.dispatch_result);
  const binding = { id, project_id: "P", parent_ticket_id: "PARENT", parent_execution_id: "RUN-PARENT", job_id: "BLOCKER" };
  const services = { ticketId: "UP", ticketStatusStore: f.statuses, queueStore: f.store, disposition: f.services.disposition };
  await assertDependencyRepairDispatch(binding, services);
  f.state.cancelled.add("PARENT");
  await assert.rejects(assertDependencyRepairDispatch(binding, services), { code: "DEPENDENCY_REPAIR_CANCELLED" });
});
