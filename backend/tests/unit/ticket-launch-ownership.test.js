// Verifies durable Ticket launch ownership, rollback, restart retention, and safe handoff quarantine without live RUN.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";
import { createDurableQueue } from "../../src/modules/supervisor/durable-queue.js";

const BASIS = { project_id: "PROJECT-A", sprint_id: "SPRINT-A", plan_id: "PLAN-A", plan_revision: 1, plan_path: "plans/a.json", plan_sha256: "a".repeat(64), version: 2 };
const INPUT = { executionId: "RUN-A", basis: BASIS, requestId: "REQ-A", jobId: "JOB-A", supervisorId: "SUP-A", agentId: "CODER-A", claimId: "CLAIM-A", validate: () => {} };

test("launch claim and history commit once and survive later status writers and process restart", async () => withStore(async ({ store, database, root }) => {
  const receipt = store.claimExecutionLaunch("TICKET-A", INPUT);
  assert.equal(receipt.state, "launch_claimed");
  assert.deepEqual(receipt.dependency_expectations, []);
  assert.equal(store.getHistory("TICKET-A").at(-1).reason, "execution_launch_claimed");
  assert.equal(store.getHistory("TICKET-A").at(-1).details.launch_claim.job_id, "JOB-A");
  store.updateStatus("TICKET-A", "failed", { reason: "provider_outcome_unknown" });
  assert.deepEqual(store.get("TICKET-A").details.launch_claim, receipt);
  const reopened = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  try {
    const restored = createTicketStatusStore({ database: reopened, projectId: "PROJECT-A" });
    assert.deepEqual(restored.get("TICKET-A").details.launch_claim, receipt);
    assert.equal(database.databasePath, reopened.databasePath);
  } finally { await reopened.close(); }
}));

test("a lost response does not authorize relaunching the same execution with another request", async () => withStore(async ({ store }) => {
  store.claimExecutionLaunch("TICKET-A", INPUT);
  for (const input of [INPUT, { ...INPUT, requestId: "REQ-NEW", jobId: "JOB-NEW" }]) {
    assert.throws(() => store.claimExecutionLaunch("TICKET-A", input), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", retryable: false, launch_claim_conflict: true });
  }
  assert.equal(store.getHistory("TICKET-A").filter((entry) => entry.reason === "execution_launch_claimed").length, 1);
}));

test("failed or reset status cannot authorize replacement while previous launch remains unreconciled", async () => withStore(async ({ store, root }) => {
  const previous = store.claimExecutionLaunch("TICKET-A", INPUT);
  store.updateStatus("TICKET-A", "failed", { reason: "provider_outcome_unknown" });
  for (const fresh of [false, true]) {
    const current = store.get("TICKET-A");
    assert.throws(() => store.beginExecution("TICKET-A", { executionId: "RUN-B", basis: BASIS, expectedVersion: current.version, dependencyExpectations: [], fresh }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", retryable: false });
    assert.deepEqual(store.get("TICKET-A"), current);
  }
  store.retry("TICKET-A");
  const reopened = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  try {
    const restored = createTicketStatusStore({ database: reopened, projectId: "PROJECT-A" });
    const current = restored.get("TICKET-A");
    assert.throws(() => restored.beginExecution("TICKET-A", { executionId: "RUN-B", basis: BASIS, expectedVersion: current.version, dependencyExpectations: [] }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", retryable: false });
    assert.deepEqual(restored.get("TICKET-A").details.launch_claim, previous);
  } finally { await reopened.close(); }
  assert.deepEqual(store.getHistory("TICKET-A").find((entry) => entry.reason === "execution_launch_claimed").details.launch_claim, previous);
}));

test("failed authority validation rolls back launch ownership and does not consume the execution", async () => withStore(async ({ store }) => {
  const before = store.get("TICKET-A"); const history = store.getHistory("TICKET-A");
  assert.throws(() => store.claimExecutionLaunch("TICKET-A", { ...INPUT, validate: () => { throw Object.assign(new Error("Dependency replaced"), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" }); } }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
  assert.deepEqual(store.get("TICKET-A"), before); assert.deepEqual(store.getHistory("TICKET-A"), history);
  assert.equal(store.claimExecutionLaunch("TICKET-A", INPUT).execution_id, "RUN-A");
}));

test("wrong Project, immutable basis, execution or unbounded request identity cannot claim launch", async () => withStore(async ({ store }) => {
  for (const input of [
    { ...INPUT, basis: { ...BASIS, project_id: "PROJECT-B" } },
    { ...INPUT, basis: { ...BASIS, plan_sha256: "b".repeat(64) } },
    { ...INPUT, executionId: "RUN-OLD" }, { ...INPUT, requestId: "x".repeat(201) }
  ]) assert.throws(() => store.claimExecutionLaunch("TICKET-A", input));
  assert.equal(store.get("TICKET-A").details.launch_claim, undefined);
}));

test("two actual processes cannot commit two launch owners for the same execution", { timeout: 20000 }, async () => withStore(async ({ store, root }) => {
  const worker = fileURLToPath(new URL("../fixtures/ticket-launch-worker.mjs", import.meta.url));
  const execute = promisify(execFile);
  const results = await Promise.all([1, 2].map(async () => {
    const { stdout } = await execute(process.execPath, [worker, root], { timeout: 15000 });
    return JSON.parse(stdout.trim());
  }));
  assert.equal(results.filter((result) => result.claimed).length, 1);
  assert.equal(results.find((result) => !result.claimed).code, "TICKET_EXECUTION_RECONCILIATION_REQUIRED");
  assert.deepEqual(store.get("TICKET-A").details.launch_claim, results.find((result) => result.claimed).receipt);
  assert.equal(store.getHistory("TICKET-A").filter((entry) => entry.reason === "execution_launch_claimed").length, 1);
}));

test("quarantined handoffs retain original intent and cannot be claimed or automatically recovered", async () => {
  const items = new Map();
  const queue = createDurableQueue({ name: "sender.handoff", store: { list: async () => [...items.values()], save: async (_name, item) => items.set(item.id, structuredClone(item)) } });
  const job = await queue.enqueue({ request_id: "REQ-A", payload: { execution_id: "RUN-A", dependency_expectations: [{ execution_id: "RUN-DEPENDENCY" }] } });
  await assert.rejects(queue.quarantine(job.id, { requestId: "REQ-WRONG" }));
  assert.equal(items.get(job.id).status, "queued");
  const disposed = await queue.quarantine(job.id, { requestId: "REQ-A", reason: "dependency_rebound" });
  assert.equal(disposed.status, "dead_letter"); assert.equal(disposed.reconciliation_required, true);
  assert.deepEqual(disposed.payload, job.payload);
  assert.deepEqual(await queue.recover(), []); assert.equal(await queue.claim("restart-worker"), null);
});

// Builds one captured-intent execution in disposable SQLite storage; no approval or provider is synthesized for RUN.
async function withStore(callback) {
  const root = await mkdtemp(join(tmpdir(), "ticket-launch-ownership-"));
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  try {
    const store = createTicketStatusStore({ database, projectId: "PROJECT-A" });
    const current = store.create("TICKET-A");
    store.beginExecution("TICKET-A", { executionId: "RUN-A", basis: BASIS, expectedVersion: current.version, dependencyExpectations: [] });
    await callback({ store, database, root });
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
}
