import assert from "node:assert/strict";
import test from "node:test";

import { createIdempotentRecovery } from "../../src/modules/recovery/idempotent-recovery.js";

const guard = createIdempotentRecovery();

test("blocks a completed step after recovery", () => {
  assert.equal(guard.shouldExecute({ session: runningSession(), stepId: "STEP-A", state: state({ completed: ["STEP-A"] }) }), false);
});

test("allows a pending step after recovery deterministically", () => {
  const input = { session: runningSession(), stepId: "STEP-C", state: state({ completed: ["STEP-A", "STEP-B"] }) };
  assert.equal(guard.shouldExecute(input), true);
  assert.equal(guard.shouldExecute(input), true);
});

test("blocks duplicate completion for completed and failed workflows", () => {
  assert.equal(guard.shouldComplete({ session: { id: "SESSION-102", state: "COMPLETED" }, state: state({ status: "completed" }) }), false);
  assert.equal(guard.shouldComplete({ session: { id: "SESSION-102", state: "FAILED" }, state: state({ status: "failed" }) }), false);
  assert.equal(guard.shouldComplete({ session: runningSession(), state: state() }), true);
});

function runningSession() {
  return { id: "SESSION-102", state: "RUNNING" };
}

function state({ completed = [], status = "unknown" } = {}) {
  return {
    sessions: { "SESSION-102": { state: "RUNNING", task_id: "TASK-102" } },
    tasks: { "TASK-102": { status, completed_step_ids: completed } }
  };
}
