// Verifies installed CLI provider event contracts retain block identities and text-command
// ordering without private reasoning, tool output, duplicate snapshots, or cross-subagent text.
import assert from "node:assert/strict";
import test from "node:test";
import { createSystemEngineerSdkTranscript } from "../../src/application/system-engineer-sdk-transcript.js";

// Builds Codex lifecycle snapshots using the installed SDK's ThreadEvent contract.
function codex(type, id, kind, extra) {
  return { type: `item.${type}`, item: { id, type: kind, ...extra } };
}

test("Codex preserves text-command-text order while replacing snapshots in place", () => {
  const transcript = createSystemEngineerSdkTranscript("CODEX");
  transcript.accept(codex("updated", "text-1", "agent_message", { text: "Checking" }));
  transcript.accept(codex("started", "command-1", "command_execution", { command: "git diff --check" }));
  transcript.accept(codex("completed", "text-1", "agent_message", { text: "Checking files" }));
  transcript.accept(codex("completed", "command-1", "command_execution", { command: "git diff --check", aggregated_output: "PRIVATE OUTPUT", exit_code: 1 }));
  transcript.accept(codex("completed", "text-2", "agent_message", { text: "Found a failure" }));
  transcript.finish("Found a failure");
  const snapshot = transcript.snapshot();
  assert.deepEqual(snapshot.entries.map((entry) => entry.text ?? entry.command), ["Checking files", "git diff --check", "Found a failure"]);
  assert.equal(snapshot.entries[1].status, "failed");
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE OUTPUT/);
});

test("Claude partial text and tool JSON reconcile with complete blocks without duplication", () => {
  const transcript = createSystemEngineerSdkTranscript("CLAUDE");
  const partial = (event) => transcript.accept({ type: "stream_event", parent_tool_use_id: null, event });
  partial({ type: "message_start", message: { id: "msg-1" } });
  partial({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  partial({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking files" } });
  partial({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-1", name: "Bash", input: {} } });
  partial({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"git ' } });
  partial({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'diff --check"}' } });
  partial({ type: "content_block_stop", index: 1 });
  transcript.accept({ type: "assistant", message: { id: "msg-1", content: [
    { type: "text", text: "Checking files" }, { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "git diff --check" } }
  ] } });
  transcript.accept({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "PRIVATE OUTPUT", is_error: true }] } });
  transcript.accept({ type: "assistant", message: { id: "msg-2", content: [{ type: "text", text: "Found a failure" }] } });
  transcript.finish("Checking files\nFound a failure");
  const snapshot = transcript.snapshot();
  assert.deepEqual(snapshot.entries.map((entry) => entry.text ?? entry.command), ["Checking files", "git diff --check", "Found a failure"]);
  assert.equal(snapshot.entries[1].status, "failed");
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE OUTPUT/);
});

test("reasoning and subagent streams stay private and separate SDK runs keep unique identities", () => {
  const first = createSystemEngineerSdkTranscript("FIRST");
  assert.equal(first.accept(codex("completed", "hidden", "reasoning", { text: "PRIVATE" })), false);
  assert.equal(first.accept({ type: "assistant", parent_tool_use_id: "SUBAGENT", message: { content: [{ type: "text", text: "PRIVATE" }] } }), false);
  first.finish("Fallback", true);
  const second = createSystemEngineerSdkTranscript("SECOND");
  second.finish("Fallback");
  assert.notEqual(first.snapshot().entries[0].id, second.snapshot().entries[0].id);
  assert.equal(first.snapshot().status, "failed");
});
