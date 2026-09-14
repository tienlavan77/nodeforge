import assert from "node:assert/strict";
import test from "node:test";
import { SUPERVISOR_STATES, migrateLegacyState, createSupervisorRuntime } from "../../src/modules/supervisor/supervisor-runtime.js";

function runtimeStub(initialState = "CREATED") {
  const published = [];
  const runtime = createSupervisorRuntime({
    taskId: "TASK-1",
    supervisorId: "SUP-1",
    eventBus: { publish: async (event) => published.push(event) }
  });
  if (initialState !== "CREATED") awaitHydrate(runtime, initialState);
  return { runtime, published };
  function awaitHydrate() {}
}

test("supervisor state machine has exactly the 8 pipeline states", () => {
  assert.deepEqual([...SUPERVISOR_STATES], ["CREATED", "PREPARING", "READY", "RUNNING", "VERIFYING", "REPAIRING", "COMPLETED", "FAILED", "NEEDS_HUMAN_REVIEW"]);
});

test("happy path transitions CREATED to COMPLETED", async () => {
  const { runtime } = await runtimeStubValue();
  assert.equal(await runtime.transition("PREPARING"), "PREPARING");
  assert.equal(await runtime.transition("READY"), "READY");
  assert.equal(await runtime.transition("RUNNING"), "RUNNING");
  assert.equal(await runtime.transition("VERIFYING"), "VERIFYING");
  assert.equal(await runtime.transition("COMPLETED"), "COMPLETED");
});

async function runtimeStubValue() {
  const published = [];
  const runtime = createSupervisorRuntime({
    taskId: "TASK-1",
    supervisorId: "SUP-1",
    eventBus: { publish: async (event) => published.push(event) }
  });
  return { runtime, published };
}

test("invalid transition throws ConfigurationError", async () => {
  const { runtime } = await runtimeStubValue();
  await assert.rejects(() => runtime.transition("VERIFYING"), (error) => error.code === "CONFIGURATION_ERROR");
  await runtime.transition("PREPARING");
  await assert.rejects(() => runtime.transition("COMPLETED"), (error) => /Invalid Supervisor transition/.test(error.message));
});

test("repair loop is RUNNING -> REPAIRING -> RUNNING", async () => {
  const { runtime } = await runtimeStubValue();
  for (const next of ["PREPARING", "READY", "RUNNING"]) await runtime.transition(next);
  assert.equal(await runtime.transition("REPAIRING"), "REPAIRING");
  assert.equal(await runtime.transition("RUNNING"), "RUNNING");
  assert.equal(await runtime.transition("VERIFYING"), "VERIFYING");
});

test("NEEDS_HUMAN_REVIEW is reachable from RUNNING and REPAIRING and is terminal", async () => {
  const { runtime } = await runtimeStubValue();
  for (const next of ["PREPARING", "READY", "RUNNING"]) await runtime.transition(next);
  await runtime.transition("REPAIRING");
  assert.equal(await runtime.transition("NEEDS_HUMAN_REVIEW"), "NEEDS_HUMAN_REVIEW");
  await assert.rejects(() => runtime.transition("RUNNING"));
});

test("legacy states migrate to the new 8-state map", () => {
  assert.equal(migrateLegacyState("REQUESTING"), "RUNNING");
  assert.equal(migrateLegacyState("WAITING_AGENT"), "RUNNING");
  assert.equal(migrateLegacyState("MATERIALIZING"), "VERIFYING");
  assert.equal(migrateLegacyState("WAITING_REPAIR"), "REPAIRING");
  assert.equal(migrateLegacyState("RUNNING"), "RUNNING");
  assert.equal(migrateLegacyState("VERIFYING"), "VERIFYING");
  assert.equal(migrateLegacyState("REPAIRING"), "REPAIRING");
  assert.equal(migrateLegacyState("COMPLETED"), "COMPLETED");
  assert.equal(migrateLegacyState("FAILED"), "FAILED");
  assert.equal(migrateLegacyState("NEEDS_HUMAN_REVIEW"), "NEEDS_HUMAN_REVIEW");
  assert.equal(migrateLegacyState("CREATED"), "CREATED");
  assert.equal(migrateLegacyState("PREPARING"), "PREPARING");
  assert.equal(migrateLegacyState("READY"), "READY");
});
