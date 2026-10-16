// Verifies durable Coder retries with a fake clock and real locked project-scoped storage.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createFileQueueStore } from "../../src/modules/supervisor/file-queue-store.js";
import { createCoderOperationalRecovery } from "../../src/modules/supervisor/coder-operational-recovery.js";
import { classifyCoderFailure } from "../../src/modules/supervisor/coder-failure-routing.js";
import { handleTicketExecutionFailure } from "../../src/modules/supervisor/ticket-execution-failure.js";
import { createSupervisorLoop } from "../../src/modules/supervisor/supervisor-loop.js";

const basis = { project_id: "P", sprint_id: "S", plan_id: "PLAN", plan_revision: 1, plan_path: "plans/plan.md", plan_sha256: "a".repeat(64), version: 1 };
const request = { project_id: "P", task_id: "TASK", request_id: "REQ", supervisor_id: "SUP", attempt: 1,
  execution_context: { source_revision: "REV-1" }, payload: { execution_id: "EXEC", sprint_basis: basis } };
const error = { code: "SERVICE_UNAVAILABLE", provider_outcome: "failed", retry_safe: true };

// Shares only durable files between reconstructed services, modeling restarts and competing workers.
async function fixture(callback) {
  const base = resolve(".forge/test-tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "coder-recovery-"));
  let now = 1000;
  let current = true;
  const calls = [];
  const terminals = new Map();
  const store = createFileQueueStore({ fileService: createFileService({ projectRoot: root }) });
  const options = { store, policy: { policy_id: "TEST-POLICY", max_retries: 1, deadline_ms: 120_000 },
    validateExecution: async () => current, clock: () => now,
    dispatch: async (child) => calls.push(child), publishTerminal: async (event) => terminals.set(event.event_id, event) };
  const create = (overrides = {}) => createCoderOperationalRecovery({ ...options, ...overrides });
  try { await callback({ store, create, calls, terminals, advance: (delta) => { now += delta; }, stale: () => { current = false; } }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("no policy and ambiguous causes do not enable Coder retries", async () => fixture(async ({ create, store }) => {
  assert.equal((await create({ policy: null }).handleFailure({ request, error })).handled, false);
  for (const failure of [
    { code: "CONFIGURATION_ERROR", message: "Codex SDK request timed out" },
    { code: "AGENT_PROCESS_EXITED" }, { ...error, provider_outcome: "unknown" }, { ...error, retry_safe: false },
    { code: "COMMIT_APPROVAL_REJECTED", provider_outcome: "failed", retry_safe: true },
    { code: "VERIFY_STORAGE_EXHAUSTED" }, { code: "NEW_UNKNOWN_ERROR" }
  ]) assert.equal((await create().handleFailure({ request, error: failure })).handled, false);
  assert.deepEqual(await store.list("coder-operational-recovery"), []);
  assert.equal(classifyCoderFailure({ code: "CODER_BLOCKED" }), "authority");
  assert.equal(classifyCoderFailure({ code: "REVIEW_VERDICT_INVALID" }), "reviewer");
  assert.equal(classifyCoderFailure({ code: "CODER_EVIDENCE_PENDING" }), "repair");
  assert.throws(() => create({ policy: { max_retries: Infinity } }), /finite policy/);
}));

test("29.999 seconds cannot dispatch; restart at 30 seconds dispatches exactly one child", async () => fixture(async ({ create, advance, calls, store }) => {
  const first = await create().handleFailure({ request, error, source: "agent_event" });
  assert.equal(first.outcome, "pending");
  advance(29_999);
  assert.equal(await create().tick(), null);
  assert.equal(calls.length, 0);
  advance(1);
  await Promise.all([create().tick(), create().tick()]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request_id, first.record.child_request_id);
  assert.notEqual(calls[0].request_id, request.request_id);
  assert.equal(calls[0].payload.operational_retry.parent_request_id, request.request_id);
  assert.equal((await store.list("coder-operational-recovery"))[0].retries, 1);
  await create().tick();
  assert.equal(calls.length, 1);
}));

test("both failure routes share the same durable decision before terminal emission", async () => fixture(async ({ create, store }) => {
  const service = create();
  const forbidden = async () => assert.fail("Scheduled recovery must not fail the ticket");
  const sdk = await handleTicketExecutionFailure({ error, failedRequest: request, coderRecovery: service, publishTicketOutcome: forbidden });
  const loop = createSupervisorLoop({ runtime: { taskId: "TASK", supervisorId: "SUP", transition: forbidden },
    sourceRequest: async (_taskId, requestId) => { assert.equal(requestId, "REQ"); return request; }, eventBus: { publish: forbidden },
    requestStore: { claim: forbidden }, coderRecovery: create() });
  assert.equal(await loop.onEvent({ task_id: "TASK", supervisor_id: "SUP", request_id: "REQ", type: "agent.response.failed", payload: { error } }), true);
  const ledger = (await store.list("coder-operational-recovery"))[0];
  assert.equal(ledger.failures.length, 1);
  assert.equal(ledger.retries, 1);
  assert.equal(ledger.failures[0].child_request_id, sdk.record.child_request_id);
}));

test("repair revisions and provider changes do not reset the Coder recovery budget", async () => fixture(async ({ create, advance, calls, terminals, store }) => {
  await create().handleFailure({ request, error });
  advance(30_000);
  await create().tick();
  const repaired = { ...calls[0], provider: "another-provider", execution_context: { source_revision: "REV-2" } };
  assert.equal((await create().handleFailure({ request: repaired, error })).outcome, "terminal_pending");
  await Promise.all([create().tick(), create().tick()]);
  assert.equal(terminals.size, 1);
  assert.equal(calls.length, 1);
  assert.equal((await store.list("coder-operational-recovery"))[0].retries, 1);
}));

test("stale execution and explicit cancellation invalidate pending retries", async () => {
  for (const cancelled of [false, true]) await fixture(async ({ create, advance, calls, stale, store }) => {
    await create().handleFailure({ request, error });
    if (cancelled) await create().cancel({ projectId: "P", taskId: "TASK", executionId: "EXEC" });
    else stale();
    advance(30_000);
    await create().tick();
    assert.equal(calls.length, 0);
    assert.equal((await store.list("coder-operational-recovery"))[0].failures[0].status, "cancelled");
  });
});

test("Stop before the first failure persists cancellation across recovery reconstruction", async () => fixture(async ({ create, advance, store, calls }) => {
  await create().cancel({ projectId: "P", taskId: "TASK", executionId: "EXEC" });
  await create().handleFailure({ request, error });
  advance(30_000);
  await create().tick();
  assert.equal(calls.length, 0);
  assert.equal((await store.list("coder-operational-recovery"))[0].cancelled, true);
}));

test("unknown dispatch outcome is audited and never replayed after restart or deadline", async () => fixture(async ({ create, advance, store, calls }) => {
  await create().handleFailure({ request, error });
  advance(30_000);
  await assert.rejects(create({ dispatch: async () => { throw Object.assign(new Error("Outcome unknown"), { code: "PROVIDER_UNKNOWN" }); } }).tick(), /Outcome unknown/);
  advance(300_000);
  await create().tick();
  assert.equal(calls.length, 0);
  assert.equal((await store.list("coder-operational-recovery"))[0].failures[0].status, "reconciliation_required");
}));

test("a crash after invoking was persisted never reclaims the provider invocation", async () => fixture(async ({ create, advance, calls, store }) => {
  await create().handleFailure({ request, error });
  const [ledger] = await store.list("coder-operational-recovery");
  ledger.failures[0].status = "invoking";
  await store.withLock("coder-operational-recovery", () => store.save("coder-operational-recovery", ledger));
  advance(300_000);
  await create().tick();
  assert.equal(calls.length, 0);
}));

test("deadline prevents late restart catch-up and emits one logical terminal event", async () => fixture(async ({ create, advance, calls, terminals }) => {
  await create().handleFailure({ request, error });
  advance(120_000);
  await create().tick();
  await create().tick();
  assert.equal(calls.length, 0);
  assert.equal(terminals.size, 1);
}));

test("a conflicting unknown outcome or owner rejection cancels an already scheduled retry", async () => {
  for (const code of ["PROVIDER_UNKNOWN", "COMMIT_APPROVAL_REJECTED"]) await fixture(async ({ create, advance, calls, store }) => {
    await create().handleFailure({ request, error });
    const decision = await create().handleFailure({ request, error: { code } });
    assert.equal(decision.handled, code === "PROVIDER_UNKNOWN");
    advance(30_000);
    await create().tick();
    assert.equal(calls.length, 0);
    assert.equal((await store.list("coder-operational-recovery"))[0].failures[0].conflicting_failure_code, code);
  });
});

test("old queued failure cannot transition or release a replacement execution even with retry disabled", async () => {
  const forbidden = async () => assert.fail("Stale failure must not affect a replacement execution");
  const loop = createSupervisorLoop({ runtime: { taskId: "TASK", supervisorId: "SUP", transition: forbidden },
    eventBus: { publish: forbidden }, sourceRequest: async () => request,
    ticketStatusStore: { get: () => ({ project_id: "P", details: { execution_id: "REPLACEMENT", execution_basis: basis } }) },
    agentOccupancy: { getByTask: forbidden, release: forbidden } });
  assert.equal(await loop.onEvent({ type: "agent.response.failed", supervisor_id: "SUP", request_id: "REQ", payload: { error } }), true);
});
