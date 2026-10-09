// Prevents double-Escape recovery controls from waiting for typing completion or a human-message retry.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { awaitingOwnerExecutionRecovery, watchOwnerExecutionRecovery } from "../lib/owner-execution-recovery.js";

// Supplies controlled checkpoint responses and a manual clock to verify delayed stop persistence.
function fixture(responses) {
  const updates = [];
  const errors = [];
  const timers = [];
  const calls = [];
  const stop = watchOwnerExecutionRecovery({
    client: { listOwnerExecutions: async (...args) => { calls.push(args); const result = responses.shift(); if (result instanceof Error) throw result; return result; } },
    projectId: "P", conversationId: "C", executionId: "E",
    onUpdate: (items) => updates.push(items), onError: (error) => errors.push(error),
    schedule: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    cancel: (timer) => { timer.cancelled = true; }
  });
  return { updates, errors, timers, calls, stop };
}

test("pending stop refreshes repeatedly until authorized recovery, without typing or message retry", async () => {
  const running = { conversation_id: "C", execution_id: "E", status: "running", can_continue: false };
  const interrupted = { ...running, status: "interrupted", can_restart: false, can_discard: false };
  const ready = { ...interrupted, can_continue: true, can_restart: true, can_discard: true };
  const state = fixture([{ items: [running] }, { items: [interrupted] }, { items: [ready] }]);
  await setImmediate();
  assert.equal(state.updates[0][0].status, "pausing");
  assert.equal(awaitingOwnerExecutionRecovery(state.updates[0][0]), true);
  assert.equal(state.timers[0].delay, 500);
  await state.timers[0].callback();
  assert.equal(awaitingOwnerExecutionRecovery(state.updates[1][0]), true);
  await state.timers[1].callback();
  assert.deepEqual(state.updates[2], [ready]);
  assert.equal(awaitingOwnerExecutionRecovery(ready), false);
  state.stop();
  assert.equal(state.timers[2].cancelled, true);
  assert.deepEqual(state.calls, [["P", "C"], ["P", "C"], ["P", "C"]]);
});

test("transient refresh failure is visible and does not strand recovery", async () => {
  const state = fixture([new Error("temporary failure"), { items: [{ execution_id: "E", status: "interrupted", can_restart: true }] }]);
  await setImmediate();
  assert.deepEqual(state.errors, ["temporary failure"]);
  await state.timers[0].callback();
  assert.equal(state.updates[0][0].can_restart, true);
  state.stop();
});

test("navigation ignores an in-flight response and never schedules another request", async () => {
  let resolve;
  let calls = 0;
  const stop = watchOwnerExecutionRecovery({
    client: { listOwnerExecutions: () => { calls += 1; return new Promise((done) => { resolve = done; }); } },
    projectId: "P", conversationId: "C", executionId: "E",
    onUpdate: () => assert.fail("stale conversation update"), onError: () => assert.fail("stale error"),
    schedule: () => assert.fail("scheduled after navigation")
  });
  await setImmediate();
  assert.equal(calls, 1);
  stop();
  resolve({ items: [] });
  await setImmediate();
});

test("manual verification remains gated, while terminal or actionable records stop polling", () => {
  assert.equal(awaitingOwnerExecutionRecovery({ status: "manual_required" }), true);
  assert.equal(awaitingOwnerExecutionRecovery({ status: "manual_required", can_reconcile: true }), false);
  assert.equal(awaitingOwnerExecutionRecovery({ status: "manual_required", can_discard: true }), false);
  for (const status of ["running", "completed", "discarded", "restarted"]) assert.equal(awaitingOwnerExecutionRecovery({ status }), false);
  assert.equal(awaitingOwnerExecutionRecovery(undefined), false);
});

test("both Escape controls watch stop independently and show disabled recovery actions immediately", async () => {
  for (const role of ["architecture", "system"]) {
    const source = await readFile(`ui/nextjs/components/${role}-execution-controls.jsx`, "utf8");
    assert.match(source, /awaitingOwnerExecutionRecovery\(current\)/);
    assert.match(source, /return watchOwnerExecutionRecovery\(/);
    assert.doesNotMatch(source, /!conversationId \|\| agentTyping \|\| !awaitingStop/);
    assert.match(source, /\["pausing", "interrupted"\]\.includes\(/);
    assert.match(source, /disabled=\{busy \|\| current\??\.?[\s\S]*?=== "pausing" \|\| !current\?\.\[`can_\$\{action\}`\]\}/);
    assert.match(source, /decide\("pause"\)/);
  }
});
