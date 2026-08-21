import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadWorkflowDefinition } from "../../src/modules/workflows/state-machine-executor.js";
import { createWorkflowTransitionGate } from "../../src/modules/workflows/workflow-transition-gate.js";

const workflowPath = fileURLToPath(new URL("../../workflows/forge-sprint-delivery.workflow.json", import.meta.url));
const projectId = "PROJECT-workflow-integration";
const taskId = "TASK-073";

test("runs the configured workflow through rule-gated test pass, approval, and restart", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-workflow-integration-"));
  try {
    const workflow = await loadWorkflowDefinition(workflowPath);
    const firstGate = createGate(workflow, projectRoot);

    const started = await firstGate.transition({
      taskId, currentState: workflow.initial_state, event: "builder.start", trigger: "commit.transition",
      context: startContext(taskId)
    });
    assertTransition(started, true, "PLANNED", "builder.start", "IN_PROGRESS");

    const denied = await firstGate.transition({
      taskId, currentState: "IN_PROGRESS", event: "builder.handoff", trigger: "commit.handoff",
      context: { roadmap: { commit: { id: "NF-073" } }, task: { id: taskId } }
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.rule_id, "WF-003");
    assert.equal(denied.state_before, "IN_PROGRESS");
    assert.equal(denied.state_after, "IN_PROGRESS");
    assert.equal((await readRuntimeState(projectRoot)).tasks[taskId].workflow_state, "IN_PROGRESS");

    const handedOff = await firstGate.transition({
      taskId, currentState: "IN_PROGRESS", event: "builder.handoff", trigger: "commit.handoff",
      context: handoffContext(taskId)
    });
    assertTransition(handedOff, true, "IN_PROGRESS", "builder.handoff", "TESTING");

    const passed = await firstGate.transition({
      taskId, currentState: "TESTING", event: "test.pass", trigger: "test.pass",
      context: { actor: "node", task: { id: taskId, workflow_state: "TESTING" } }
    });
    assertTransition(passed, true, "TESTING", "test.pass", "READY_FOR_REVIEW");

    // A fresh gate reads state.json and continues the same workflow after a Node restart.
    const restartedGate = createGate(workflow, projectRoot);
    const approved = await restartedGate.transition({
      taskId, currentState: "READY_FOR_REVIEW", event: "reviewer.approve", trigger: "review.complete",
      context: approvalContext()
    });
    assertTransition(approved, true, "READY_FOR_REVIEW", "reviewer.approve", "APPROVED");
    assert.deepEqual((await readRuntimeState(projectRoot)).tasks[taskId], {
      workflow_id: "forge-sprint-delivery",
      workflow_state: "APPROVED",
      updated_at: "2026-08-19T10:00:00.000Z",
      _version: 4
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("returns a failed test to IN_PROGRESS without changing the workflow definition", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-workflow-test-fail-"));
  try {
    const workflow = await loadWorkflowDefinition(workflowPath);
    const gate = createGate(workflow, projectRoot);
    await gate.transition({ taskId: "TASK-073-fail", currentState: "PLANNED", event: "builder.start", trigger: "commit.transition", context: startContext("TASK-073-fail") });
    await gate.transition({ taskId: "TASK-073-fail", currentState: "IN_PROGRESS", event: "builder.handoff", trigger: "commit.handoff", context: handoffContext("TASK-073-fail") });
    const failed = await gate.transition({
      taskId: "TASK-073-fail", currentState: "TESTING", event: "test.fail", trigger: "test.fail",
      context: { actor: "node", task: { id: "TASK-073-fail", workflow_state: "TESTING" } }
    });
    assertTransition(failed, true, "TESTING", "test.fail", "IN_PROGRESS");
    assert.equal((await readRuntimeState(projectRoot)).tasks["TASK-073-fail"].workflow_state, "IN_PROGRESS");
    assert.equal(workflow.states.includes("TESTING"), true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function createGate(workflow, projectRoot) {
  return createWorkflowTransitionGate({
    workflow,
    projectId,
    projectRoot,
    internalBus: new EventEmitter(),
    clock: () => new Date("2026-08-19T10:00:00Z")
  });
}

function startContext(id) {
  return { actor: "builder", task: { id, workflow_state: "PLANNED" }, roadmap: { commit: { id: "NF-073" } } };
}

function handoffContext(id) {
  return {
    roadmap: { commit: { id: "NF-073" } },
    task: { id },
    builder_evidence: [{
      id: "EVIDENCE-073", project_id: projectId, task_id: id, session_id: "SESSION-073", builder_id: "AGENT-BUILDER-073",
      evidence_type: "implementation_summary", payload: { summary: "Implemented the configured workflow handoff." }, created_at: "2026-08-19T10:00:00Z"
    }]
  };
}

function approvalContext() {
  return {
    actor: "reviewer",
    review_result: { status: "approved", findings: [] },
    verification_result: { ready_for_review: true },
    verification_run: { level: "full", status: "passed", checks: [{ status: "passed", command: "npm test", result_ref: "RESULT-073" }] },
    results: { "RESULT-073": { status: "passed" } }
  };
}

async function readRuntimeState(projectRoot) {
  return JSON.parse(await readFile(join(projectRoot, ".forge/runtime/state.json"), "utf8"));
}

function assertTransition(result, allowed, from, event, to) {
  assert.equal(result.allowed, allowed);
  assert.equal(result.transitioned, allowed);
  assert.deepEqual({ from: result.from, event: result.event, to: result.to }, { from, event, to });
  assert.equal(result.state_after, to);
}
