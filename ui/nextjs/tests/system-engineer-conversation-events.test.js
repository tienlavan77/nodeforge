// Verifies lossless SE transcript rendering state, replay identity and role/conversation scope.
import assert from "node:assert/strict";
import test from "node:test";
import { appendSystemEngineerConversationEvent, systemEngineerConversationEvent } from "../lib/system-engineer-conversation-events.js";
import { reconcileConversationHistory } from "../lib/conversation-history-reconciliation.js";

// Provides full SE envelopes with identities shared by live delivery and persisted records.
function activity(index, sdkEvent = { type: "conversation_turn", entries: [{ id: `T-${index}`, type: "text", text: `Reply ${index}` }] }) {
  return { event_id: `LIVE-${index}`, event_type: "agent.activity", timestamp: `2026-10-22T00:00:${String(index % 60).padStart(2, "0")}Z`,
    payload: { activity_id: `ACT-${index}`, agent_role: "system_engineer", conversation_id: "CHAT", correlation_id: `RUN-${index}`, sdk_sequence: index, sdk_event: sdkEvent } };
}

// Excludes command-only events from the chat stream so tool calls stay only in the Agent Activity panel.
test("SE conversation excludes command_execution blocks from chat while keeping text turns", () => {
  let messages = [];
  for (let index = 0; index < 10; index += 1) messages = appendSystemEngineerConversationEvent(messages, activity(index,
    { type: "command_execution", command: "git diff --check" }), "CHAT", "Engineer");
  assert.equal(messages.length, 0);
});

// Replayed frames and reload history use the persistent activity id, not fresh SSE frame ids.
test("reconnect reconciles each text turn independently", () => {
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

// Raw tool output, command_execution, and lifecycle envelopes never enter chat messages.
test("command_execution and raw envelopes do not enter the SE chat transcript", () => {
  const messages = [];
  for (const sdkEvent of [
    { type: "command_execution", command: "git status" },
    { type: "item.completed", item: { type: "command_execution", command: "git status", aggregated_output: "never store me" } },
    { type: "assistant", message: { content: [{ type: "text", text: "never store me" }] } },
    { type: "result", result: "never store me" }
  ]) assert.equal(appendSystemEngineerConversationEvent(messages, activity(1, sdkEvent), "CHAT", "SE"), messages);
});

// A saved turn and its live snapshots refer to one card and filter out command_execution blocks.
test("reloaded turn replaces the live card and retains only text blocks in chat", () => {
  const first = { ...activity(1, { type: "conversation_turn", entries: [{ id: "INTRO", type: "text", text: "Checking" }] }), payload: { ...activity(1).payload, correlation_id: "RUN", sdk_event: { type: "conversation_turn", entries: [{ id: "INTRO", type: "text", text: "Checking" }] } } };
  const live = appendSystemEngineerConversationEvent([], first, "CHAT", "Engineer");
  const completed = { ...activity(3), payload: { ...activity(3).payload, correlation_id: "RUN", sdk_event: { type: "conversation_turn", entries: [
    { id: "INTRO", type: "text", text: "Checking" },
    { id: "COMMAND", type: "command_execution", command: "git diff" },
    { id: "FINAL", type: "text", text: "Done" }
  ] } } };
  const saved = systemEngineerConversationEvent({ id: "SE-TURN", payload: completed.payload, timestamp: completed.timestamp }, "Engineer");
  const messages = reconcileConversationHistory(live, [saved]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].stream_key, "agent:RUN");
  assert.deepEqual(messages[0].se_event.entries.map((entry) => entry.type), ["text", "text"]);
  assert.equal(appendSystemEngineerConversationEvent(messages, first, "CHAT", "Engineer"), messages);
});
