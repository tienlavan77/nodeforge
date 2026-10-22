// Verifies lossless SE transcript rendering state, replay identity and role/conversation scope.
import assert from "node:assert/strict";
import test from "node:test";
import { appendSystemEngineerConversationEvent, systemEngineerConversationEvent } from "../lib/system-engineer-conversation-events.js";
import { reconcileConversationHistory } from "../lib/conversation-history-reconciliation.js";

// Provides full SE envelopes with identities shared by live delivery and persisted records.
function activity(index, sdkEvent = { type: "command_execution", command: "git status --short" }) {
  return { event_id: `LIVE-${index}`, event_type: "agent.activity", timestamp: `2026-10-22T00:00:${String(index % 60).padStart(2, "0")}Z`,
    payload: { activity_id: `ACT-${index}`, agent_role: "system_engineer", conversation_id: "CHAT", correlation_id: "RUN", sdk_sequence: index, sdk_event: sdkEvent } };
}

// Keeps all transcript events even though the separate monitor has a 50-entry display budget.
test("SE conversation keeps every long tool event without folding or a 50-event cap", () => {
  let messages = [];
  for (let index = 0; index < 75; index += 1) messages = appendSystemEngineerConversationEvent(messages, activity(index,
    { type: "command_execution", command: "git diff --check" }), "CHAT", "Engineer");
  assert.equal(messages.length, 75);
  assert.equal(messages[74].se_event.command, "git diff --check");
  assert.equal(messages[0].retryable, false);
});

// Replayed frames and reload history use the persistent activity id, not fresh SSE frame ids.
test("reconnect reconciles each event independently even when all share one correlation", () => {
  const first = activity(1);
  const second = activity(2);
  const live = [first, second].reduce((messages, event) => appendSystemEngineerConversationEvent(messages, event, "CHAT", "SE"), []);
  assert.equal(appendSystemEngineerConversationEvent(live, { ...first, event_id: "NEW-SSE-ID" }, "CHAT", "SE"), live);
  const history = [first, second].map((event) => systemEngineerConversationEvent({ id: `SAVED-${event.event_id}`, payload: event.payload, timestamp: event.timestamp }, "SE"));
  const result = reconcileConversationHistory(live, history);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((message) => message.id), ["ACT-1", "ACT-2"]);
  assert.deepEqual(reconcileConversationHistory(result, history), result);
});

// Other roles and unscoped monitor records never become SE conversation entries.
test("only explicit SE events in the active conversation enter the transcript", () => {
  const messages = [];
  for (const role of ["architecture_manager", "coder", "reviewer", "sprint_leader", undefined]) {
    const event = activity(1);
    event.payload.agent_role = role;
    assert.equal(appendSystemEngineerConversationEvent(messages, event, "CHAT", "Agent"), messages);
  }
  assert.equal(appendSystemEngineerConversationEvent(messages, activity(1), "OTHER", "SE"), messages);
  assert.equal(appendSystemEngineerConversationEvent(messages, activity(1), null, "SE"), messages);
});

// Model text, raw tool output, and lifecycle envelopes never enter command history.
test("only command records enter the SE transcript", () => {
  const messages = [];
  for (const sdkEvent of [
    { type: "item.completed", item: { type: "command_execution", command: "git status", aggregated_output: "never store me" } },
    { type: "assistant", message: { content: [{ type: "text", text: "never store me" }] } },
    { type: "result", result: "never store me" }
  ]) assert.equal(appendSystemEngineerConversationEvent(messages, activity(1, sdkEvent), "CHAT", "SE"), messages);
});

// A saved turn and its live snapshots refer to one card rather than separate command and text messages.
test("reloaded turn replaces the live card and preserves native block order", () => {
  const first = activity(1, { type: "conversation_turn", entries: [{ id: "INTRO", type: "text", text: "Checking" }] });
  const live = appendSystemEngineerConversationEvent([], first, "CHAT", "Engineer");
  const completed = activity(3, { type: "conversation_turn", entries: [
    { id: "INTRO", type: "text", text: "Checking" },
    { id: "COMMAND", type: "command_execution", command: "git diff" },
    { id: "FINAL", type: "text", text: "Done" }
  ] });
  const saved = systemEngineerConversationEvent({ id: "SE-TURN", payload: completed.payload, timestamp: completed.timestamp }, "Engineer");
  const messages = reconcileConversationHistory(live, [saved]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].stream_key, "agent:RUN");
  assert.deepEqual(messages[0].se_event.entries.map((entry) => entry.type), ["text", "command_execution", "text"]);
  assert.equal(appendSystemEngineerConversationEvent(messages, first, "CHAT", "Engineer"), messages);
});
