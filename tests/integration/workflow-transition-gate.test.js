import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkflowTransitionGate } from "../../src/modules/workflows/workflow-transition-gate.js";

const workflow = {
  id: "WORKFLOW-gated", name: "Gated workflow", version: "1.0.0", initial_state: "PLANNED",
  states: ["PLANNED", "IN_PROGRESS", "READY_FOR_REVIEW", "APPROVED"], terminal_states: ["APPROVED"],
  transitions: [
    { from: "PLANNED", event: "start", to: "IN_PROGRESS" },
    { from: "READY_FOR_REVIEW", event: "approve", to: "APPROVED" }
  ]
};

async function setup() {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-transition-gate-"));
  const internalBus = new EventEmitter();
  const events = [];
  internalBus.on("event", (event) => events.push(event));
  const gate = createWorkflowTransitionGate({
    workflow,
    projectId: "PROJECT-transition-gate",
    projectRoot,
    internalBus,
    clock: () => new Date("2026-08-19T09:00:00Z"),
    createEventId: () => "EVT-transition-gate"
  });
  return { projectRoot, gate, events };
}

test("persists an allowed transition only after WF-002 passes", async () => {
  const state = await setup();
  try {
    const result = await state.gate.transition({
      taskId: "TASK-072-allow", currentState: "PLANNED", event: "start", trigger: "commit.transition",
      context: { actor: "builder", task: { workflow_state: "PLANNED" }, roadmap: { commit: { id: "NF-072" } } }
    });
    assert.equal(result.allowed, true);
    assert.equal(result.transitioned, true);
    assert.deepEqual(pickTransition(result), { from: "PLANNED", event: "start", to: "IN_PROGRESS", state_before: "PLANNED", state_after: "IN_PROGRESS" });
    const persisted = JSON.parse(await readFile(join(state.projectRoot, ".forge/runtime/state.json"), "utf8"));
    assert.deepEqual(persisted.tasks["TASK-072-allow"], {
      workflow_id: "WORKFLOW-gated", workflow_state: "IN_PROGRESS", updated_at: "2026-08-19T09:00:00.000Z"
    });
  } finally {
    await rm(state.projectRoot, { recursive: true, force: true });
  }
});

test("denies a failed WF-002 transition without writing a new state", async () => {
  const state = await setup();
  try {
    const result = await state.gate.transition({
      taskId: "TASK-072-deny", currentState: "PLANNED", event: "start", trigger: "commit.transition",
      context: { actor: "reviewer", task: { workflow_state: "PLANNED" }, roadmap: { commit: { id: "NF-072" } } }
    });
    assert.equal(result.allowed, false);
    assert.equal(result.transitioned, false);
    assert.equal(result.rule_id, "WF-002");
    assert.equal(result.state_before, "PLANNED");
    assert.equal(result.state_after, "PLANNED");
    await assert.rejects(() => readFile(join(state.projectRoot, ".forge/runtime/state.json"), "utf8"), { code: "ENOENT" });
    assert.equal(state.events[0].payload.rule_id, "WF-002");
  } finally {
    await rm(state.projectRoot, { recursive: true, force: true });
  }
});

test("applies the review rules chosen by the caller trigger", async () => {
  const state = await setup();
  try {
    const result = await state.gate.transition({
      taskId: "TASK-072-review", currentState: "READY_FOR_REVIEW", event: "approve", trigger: "review.complete",
      context: {
        actor: "reviewer",
        review_result: { status: "approved", findings: [] },
        verification_result: { ready_for_review: true },
        verification_run: { level: "full", status: "passed", checks: [{ status: "passed", command: "npm test", result_ref: "RESULT-072" }] },
        results: { "RESULT-072": { status: "passed" } }
      }
    });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.outcomes.map(({ rule_id, passed }) => ({ rule_id, passed })), [{ rule_id: "WF-006", passed: true }, { rule_id: "WF-007", passed: true }]);
  } finally {
    await rm(state.projectRoot, { recursive: true, force: true });
  }
});

function pickTransition(result) {
  const { from, event, to, state_before, state_after } = result;
  return { from, event, to, state_before, state_after };
}
