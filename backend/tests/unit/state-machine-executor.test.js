import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigurationError } from "../../src/shared/errors.js";
import { WorkflowTransitionError, createStateMachineExecutor, loadWorkflowDefinition } from "../../src/modules/workflows/state-machine-executor.js";

const workflow = {
  id: "WORKFLOW-test",
  name: "Generic test workflow",
  version: "1.0.0",
  initial_state: "QUEUED",
  states: ["QUEUED", "WORKING", "DONE"],
  terminal_states: ["DONE"],
  transitions: [
    { from: "QUEUED", event: "start", to: "WORKING" },
    { from: "WORKING", event: "finish", to: "DONE" }
  ]
};

test("executes a declared transition and exposes its initial state", () => {
  const executor = createStateMachineExecutor({ workflow });

  assert.equal(executor.initialState, "QUEUED");
  assert.deepEqual(executor.transition("QUEUED", "start"), { from: "QUEUED", event: "start", to: "WORKING" });
});

test("rejects an invalid transition and unknown state or event", () => {
  const executor = createStateMachineExecutor({ workflow });

  assert.throws(() => executor.transition("QUEUED", "finish"), WorkflowTransitionError);
  assert.throws(() => executor.transition("MISSING", "start"), /Unknown workflow state/);
  assert.throws(() => executor.transition("QUEUED", "missing"), /Unknown workflow event/);
});

test("runs a workflow after every state name is changed", () => {
  const renamed = {
    ...workflow,
    initial_state: "ALPHA",
    states: ["ALPHA", "BETA", "OMEGA"],
    terminal_states: ["OMEGA"],
    transitions: [
      { from: "ALPHA", event: "advance", to: "BETA" },
      { from: "BETA", event: "complete", to: "OMEGA" }
    ]
  };
  const executor = createStateMachineExecutor({ workflow: renamed });

  assert.deepEqual(executor.transition("ALPHA", "advance"), { from: "ALPHA", event: "advance", to: "BETA" });
  assert.deepEqual(executor.transition("BETA", "complete"), { from: "BETA", event: "complete", to: "OMEGA" });
});

test("loads a workflow definition from JSON before executing it", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "nodeforge-workflow-"));
  const workflowPath = join(directory, "workflow.json");
  try {
    await writeFile(workflowPath, JSON.stringify(workflow));
    const executor = createStateMachineExecutor({ workflow: await loadWorkflowDefinition(workflowPath) });
    assert.equal(executor.transition("WORKING", "finish").to, "DONE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an invalid workflow graph before it executes", () => {
  const invalid = { ...workflow, initial_state: "UNDECLARED" };

  assert.throws(() => createStateMachineExecutor({ workflow: invalid }), ConfigurationError);
});
