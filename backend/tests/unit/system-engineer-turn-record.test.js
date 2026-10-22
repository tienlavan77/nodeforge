// Verifies native provider snapshots and the final agent reply share one durable
// communication identity, while distinct executions, agents and projects remain isolated.
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";

// Supplies validated snapshots matching the unified stream publisher's storage envelope.
function snapshot(revision, entries, runId = "SDK-1") {
  return { id: `EVENT-${runId}-${revision}`, project_id: "PROJECT", conversation_id: "CHAT", correlation_id: "RUN",
    sender: { id: "NODE", role: "node" }, recipient: { id: "project-owner", role: "project_owner" },
    message_type: "agent.activity", timestamp: new Date().toISOString(),
    payload: { agent_role: "system_engineer", agent_id: "SE", sdk_sequence: revision,
      sdk_event: { type: "conversation_turn", run_id: runId, revision, status: "working", entries } } };
}

test("updates and completion occupy exactly one message, not one message per event", () => {
  const store = createAgentCommunicationStore();
  const first = snapshot(1, [{ id: "TEXT", type: "text", text: "Checking" }]);
  const saved = store.append(first);
  store.append(snapshot(2, [{ id: "TEXT", type: "text", text: "Checking files" }, { id: "COMMAND", type: "command_execution", command: "git diff" }]));
  store.append(first);
  store.append({ ...first, id: "FINAL", message_type: "SE.message.received", sender: { id: "SE", role: "system_engineer" }, payload: { text: "Checking files\nDone", content_type: "text/plain" } });
  const records = store.getByConversationId("CHAT");
  assert.equal(records.length, 1);
  assert.equal(records[0].id, saved.id);
  assert.equal(records[0].payload.sdk_event.entries[0].text, "Checking files");
  assert.equal(records[0].payload.text, "Checking files\nDone");
  assert.equal(records[0].payload.sdk_event.entries.length, 2);
});

test("Continue preserves previous blocks and appends a new provider run to the same reply", () => {
  const store = createAgentCommunicationStore();
  store.append(snapshot(9, [{ id: "SDK-1:TEXT", type: "text", text: "Before pause" }]));
  store.append(snapshot(1, [{ id: "SDK-2:TEXT", type: "text", text: "After Continue" }], "SDK-2"));
  assert.equal(store.getAll().length, 1);
  assert.deepEqual(store.getAll()[0].payload.sdk_event.entries.map((entry) => entry.text), ["Before pause", "After Continue"]);
  assert.equal(store.getAll()[0].payload.sdk_sequence, 2);
});

test("canonical reply identities are scoped by project, conversation, execution and agent", () => {
  const store = createAgentCommunicationStore();
  const first = snapshot(1, []);
  store.append(first);
  store.append({ ...first, project_id: "OTHER" });
  store.append({ ...first, conversation_id: "OTHER" });
  store.append({ ...first, correlation_id: "OTHER" });
  store.append({ ...first, payload: { ...first.payload, agent_id: "OTHER" } });
  assert.equal(store.getAll().length, 5);
});
