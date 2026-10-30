// Exercises availability races and read-only dependency evidence across accepted upstream repair cycles.
// Pending repair status is observable to SL without being accepted as completed evidence for Coder execution.
import assert from "node:assert/strict";
import test from "node:test";
import { dependencyRepairFixture, waitForDependency } from "../fixtures/dependency-repair-fixture.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";
import { blockerDependencyProgress } from "../../src/modules/supervisor/blocker/blocker-dependency-progress.js";
import { buildBlockerTicketProgress } from "../../src/modules/supervisor/blocker/blocker-ticket-progress.js";
import { captureDependencyExpectations, assertDependencyExpectations } from "../../src/modules/supervisor/ticket/ticket-dependency-expectations.js";

const QUEUE = "ticket.dependency-repair";

test("already_running retains the dependency request and rechecks after 30s instead of reporting a failed repair", async (t) => {
  let calls = 0;
  const f = await dependencyRepairFixture(t, { dispatch: async () => ({ status: ++calls === 1 ? "already_running" : "accepted" }) });
  await f.request(); await f.coordinator.tick();
  await waitForDependency(f, (entry) => entry?.status === "queued" && entry.available_at);
  assert.equal(await f.coordinator.refresh(f.job), false);
  await f.coordinator.tick(); assert.equal(calls, 1);
  f.state.now += 30000;
  await f.coordinator.tick(); await waitForDependency(f, (entry) => entry?.dispatch_result?.status === "accepted");
  assert.equal(calls, 2);
  assert.equal((await f.checkpoints.load("UP")).last_completed_turn, 36);
});

test("a busy Coder discovered after resume preflight enters the durable 30s queue even for direct RUN", async (t) => {
  const f = await dependencyRepairFixture(t);
  await f.request(); await f.coordinator.tick(); await waitForDependency(f, (entry) => entry?.dispatch_result);
  let calls = 0;
  const run = createTicketRunDispatch({ projectId: "P", ticketStatusStore: f.statuses, sprintRegistry: f.registry, queueStore: f.store,
    checkpoints: f.checkpoints, disposition: f.services.disposition, intake: { open: async () => ({ ticket: f.specs[0] }) },
    agentResolver: { list: () => [{ agent_id: "CODER", provider: "claude", enabled: true, role: "coder", status: "ready" }] },
    agentOccupancy: { listActive: () => [] }, clock: () => f.state.now,
    dispatchTask: async ({ resume_from }) => {
      assert.equal(resume_from.last_completed_turn, 36);
      if (++calls === 1) throw Object.assign(new Error("Coder claimed by another ticket after preflight"), { code: "AGENT_BUSY", not_started: true,
        agent_wait: { claim_id: "OTHER-CLAIM", agent_id: "CODER", busy_task_id: "OTHER" } });
      return { status: "accepted" };
    } });
  t.after(() => run.close());
  const result = await run({ projectId: "P", ticketId: "UP", expectedSprintVersion: f.basis.version });
  assert.equal(result.queued, true);
  assert.equal(result.agent_wait.interval_ms, 30000);
  assert.equal(f.statuses.get("UP").status, "pending");
  f.state.now += 30000; await run.tick();
  for (let i = 0; i < 300; i++) {
    const queue = await f.store.withLock("ticket.run-agent-wait", () => f.store.list("ticket.run-agent-wait"));
    if (queue[0]?.status === "completed") break;
    if (i === 299) assert.fail("Deferred Coder did not resume");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(calls, 2);
});

test("an older duplicate-RUN failure with no provider work automatically returns to its accepted dependency wait", async (t) => {
  const f = await dependencyRepairFixture(t);
  await f.request(); await f.coordinator.tick();
  const entry = await waitForDependency(f, (entry) => entry?.dispatch_result);
  const context = await f.contexts.load("UP");
  await f.contexts.update("UP", context.version, { state: "coding" });
  const failed = { ...entry, status: "failed", dispatch_result: { status: "already_running" },
    error: { code: "DEPENDENCY_REPAIR_CONFLICT", message: "No accepted repair was produced." } };
  await f.store.save(QUEUE, failed);
  await f.coordinator.refresh(f.job);
  f.job.status = "reconciliation_required"; f.job.outcome_reason = "TICKET_EXECUTION_RECONCILIATION_REQUIRED";
  await f.store.save("blocker.recovery", { id: "LEDGER", task_id: "PARENT", project_id: "P", execution_id: "RUN-PARENT", jobs: [f.job] });
  await f.coordinator.tick();
  assert.equal((await f.store.list(QUEUE))[0].status, "queued");
  assert.equal((await f.store.list(QUEUE))[0].dispatch_result, null);
  assert.equal((await f.store.list("blocker.recovery"))[0].jobs[0].status, "dependency_wait");
  assert.equal((await f.checkpoints.load("UP")).last_completed_turn, 36);
  await f.coordinator.tick(); await waitForDependency(f, (entry) => entry?.dispatch_result?.status === "accepted");
  assert.equal(f.state.launches.length, 2);
});

test("SL sees a matching upstream repair as pending while Coder's completion gate still rejects it", async (t) => {
  const f = await dependencyRepairFixture(t);
  f.job.request.ticket.dependencies = ["UP"];
  f.job.request.payload.dependency_expectations = await captureDependencyExpectations({ projectId: "P", ticket: f.job.request.ticket,
    sprintRegistry: f.registry, ticketStatusStore: f.statuses });
  await f.request(); await f.coordinator.tick(); await waitForDependency(f, (entry) => entry?.dispatch_result);
  const input = { request: f.job.request, job: f.job, sprintRegistry: f.registry, ticketStatusStore: f.statuses };
  const progress = blockerDependencyProgress(input);
  assert.equal(progress.status, "repair_pending");
  assert.equal(progress.tickets[0].status, "pending");
  assert.equal(progress.tickets[0].acceptance, "pending");
  const evidence = await buildBlockerTicketProgress({ job: f.job, checkpoint: await f.checkpoints.load("PARENT"),
    workspace: { executionContexts: { load: async () => null }, changeLedger: { snapshot: async () => ({ entries: {} }) } },
    sprintRegistry: f.registry, ticketStatusStore: f.statuses });
  assert.equal(evidence.dependencies.status, "repair_pending");
  assert.throws(() => assertDependencyExpectations({ projectId: "P", ticket: f.job.request.ticket,
    expectations: f.job.request.payload.dependency_expectations, sprintRegistry: f.registry, ticketStatusStore: f.statuses }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
  for (const job of [undefined, { ...f.job, dependency_request_id: "OTHER" }]) {
    assert.throws(() => blockerDependencyProgress({ ...input, job }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
  }
  const expected = f.job.request.payload.dependency_expectations[0];
  expected.execution_id = "REPLACED";
  assert.throws(() => blockerDependencyProgress(input), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
});
