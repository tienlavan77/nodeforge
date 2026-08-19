import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkflowTransitionGate } from "../../src/modules/workflows/workflow-transition-gate.js";

const workflow = {
  id: "WORKFLOW-owner", name: "Owner gate workflow", version: "1.0.0", initial_state: "IN_PROGRESS",
  states: ["IN_PROGRESS", "APPROVED"], terminal_states: ["APPROVED"],
  transitions: [{ from: "IN_PROGRESS", event: "finish", to: "APPROVED" }]
};

async function setup() {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-owner-gate-"));
  const internalBus = new EventEmitter();
  const events = [];
  internalBus.on("event", (event) => events.push(event));
  const gate = createWorkflowTransitionGate({
    workflow, projectId: "PROJECT-owner-gate", projectRoot, internalBus,
    createEventId: (() => { let count = 0; return () => `EVT-owner-${++count}`; })(),
    clock: () => new Date("2026-08-19T11:00:00Z")
  });
  return { projectRoot, gate, events };
}

test("pauses a WF-008 transition and emits an owner decision request", async () => {
  const state = await setup();
  try {
    const result = await state.gate.transition({
      taskId: "TASK-074-pause", currentState: "IN_PROGRESS", event: "finish", trigger: "workflow.transition",
      context: { actor: "builder", change_kinds: ["architecture_change"] }
    });
    assert.equal(result.status, "pending_owner_decision");
    assert.equal(result.allowed, false);
    assert.equal(result.rule_id, "WF-008");
    assert.equal(state.events.at(-1).payload.request_id, result.request_id);
    assert.equal(state.events.at(-1).payload.status, "pending_owner_decision");
    await assert.rejects(() => readFile(join(state.projectRoot, ".forge/runtime/state.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(state.projectRoot, { recursive: true, force: true });
  }
});

test("continues after Owner approval and persists the transition", async () => {
  const state = await setup();
  try {
    const pending = await state.gate.transition({ taskId: "TASK-074-approve", currentState: "IN_PROGRESS", event: "finish", trigger: "workflow.transition", context: { actor: "builder", change_kinds: ["api_change"] } });
    const response = await state.gate.respondOwner({ requestId: pending.request_id, approved: true });
    assert.equal(response.status, "owner_approved");
    assert.equal(response.continued, true);
    const persisted = JSON.parse(await readFile(join(state.projectRoot, ".forge/runtime/state.json"), "utf8"));
    assert.equal(persisted.tasks["TASK-074-approve"].workflow_state, "APPROVED");
  } finally {
    await rm(state.projectRoot, { recursive: true, force: true });
  }
});

test("keeps the workflow paused after Owner rejection or no response", async () => {
  const state = await setup();
  try {
    const pending = await state.gate.transition({ taskId: "TASK-074-reject", currentState: "IN_PROGRESS", event: "finish", trigger: "workflow.transition", context: { actor: "builder", change_kinds: ["dependency_change"] } });
    assert.equal(pending.status, "pending_owner_decision");
    assert.equal((await state.gate.respondOwner({ requestId: pending.request_id, approved: false })).continued, false);
    await assert.rejects(() => readFile(join(state.projectRoot, ".forge/runtime/state.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(state.projectRoot, { recursive: true, force: true });
  }
});
