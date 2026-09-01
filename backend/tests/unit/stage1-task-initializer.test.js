import assert from "node:assert/strict";
import test from "node:test";
import { createStage1TaskInitializer } from "../../src/modules/workflows/stage1-task-initializer.js";

const ticket = { id: "FORGE-STAGE1-001", project_id: "PROJECT-STAGE1", dependencies: [] };
const requestId = "11111111-1111-4111-8111-111111111111";

function fixture({ dependencyReady = true } = {}) {
  const records = new Map();
  const branches = new Set();
  const logs = [];
  const statusStore = {
    get: (id) => records.get(id),
    create: (id, details) => { if (records.has(id)) { const e = new Error("exists"); e.code = "STATUS_EXISTS"; throw e; } const value = { ticket_id: id, status: "pending", version: 0, details }; records.set(id, value); return value; },
    dependenciesReady: (_id, ids) => ({ ready: dependencyReady && ids.length === 0, blocked_by: dependencyReady ? [] : [{ id: "DEP-1", status: "failed" }] }),
    updateStatus: (id, next, details) => { const value = { ...records.get(id), status: next, version: records.get(id).version + 1, details }; records.set(id, value); return value; },
    resetDoneForRetry: (id, details) => { const value = { ...records.get(id), status: "pending", version: records.get(id).version + 1, details }; records.set(id, value); return value; }
  };
  const gitService = { branchExists: async (name) => branches.has(name), createBranch: async (name) => { branches.add(name); return { name }; } };
  const protocolLogger = { requestSent: (entry) => logs.push({ kind: "sent", status: "sent", ...entry }), failed: (entry) => logs.push({ kind: "failed", status: "blocked", ...entry }) };
  return { records, branches, logs, initializer: createStage1TaskInitializer({ statusStore, gitService, protocolLogger, createRequestId: () => requestId }) };
}

test("initializes pending task, creates branch, and moves to running", async () => {
  const { initializer, branches, logs } = fixture();
  const result = await initializer.initTask(ticket);
  assert.equal(result.status.status, "running");
  assert.deepEqual([...branches], ["task/FORGE-STAGE1-001"]);
  assert.equal(logs[0].kind, "sent");
  assert.equal(logs[0].status, "sent");
});

test("blocks task and does not create branch when dependency is not ready", async () => {
  const { initializer, branches, logs } = fixture({ dependencyReady: false });
  const result = await initializer.initTask({ ...ticket, dependencies: ["DEP-1"] });
  assert.equal(result.status.status, "blocked");
  assert.equal(branches.size, 0);
  assert.equal(logs[0].kind, "failed");
  assert.equal(logs[0].status, "blocked");
});

test("is safe to call again after initialization", async () => {
  const { initializer, branches } = fixture();
  await initializer.initTask(ticket);
  const second = await initializer.initTask(ticket);
  assert.equal(second.status.status, "running");
  assert.equal(branches.size, 1);
});

test("reconciles stale runtime done when roadmap ticket is failed", async () => {
  const fixtureData = fixture();
  fixtureData.records.set(ticket.id, { ticket_id: ticket.id, status: "done", version: 3 });
  const result = await fixtureData.initializer.initTask({ ...ticket, status: "failed" });
  assert.equal(result.status.status, "running");
  assert.equal(fixtureData.records.get(ticket.id).status, "running");
});
