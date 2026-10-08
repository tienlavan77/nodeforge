// Verifies streamed owner-agent replies keep their declared format from delta through persistence.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerAgentStream } from "../../src/application/owner-agent-stream.js";

// Runs one provider response and returns its public events and persisted protocol response.
async function runReply(responseContentType) {
  const events = [];
  const saved = [];
  const bus = { send: (event) => events.push(event), sendFast: (event) => events.push(event), flush: async () => {} };
  const stream = createOwnerAgentStream({
    bus,
    agentStream: async function* () { yield { text: "hello" }; },
    enrichAgentText: async () => "prompt",
    responseMessage: (message, type, payload) => ({ ...message, message_type: type, payload }),
    protocolStorage: { save: async (_ref, message) => saved.push(message) },
    debug: () => {}, projectLogger: () => {}, safeLog: () => {}
  });
  await stream({ id: "MSG-1", project_id: "PROJECT-A", conversation_id: "CONV-A", correlation_id: "CORR-A", payload: { text: "hello", ...(responseContentType ? { response_content_type: responseContentType } : {}) } }, "architecture-manager");
  await new Promise((resolve) => setImmediate(resolve));
  return { events, saved };
}

test("generic agent replies stay plain in deltas, completion, and persisted response", async () => {
  const { events, saved } = await runReply();
  assert.deepEqual(events.filter((event) => event.message_type.endsWith("message.delta") || event.message_type.endsWith("message.received")).map((event) => event.payload.content_type), ["text/plain", "text/plain"]);
  assert.equal(saved[0].payload.content_type, "text/plain");
  assert.equal(saved[0].payload.markdown_provenance, undefined);
});

test("explicit owner Markdown opt-in stays consistent and persists provenance", async () => {
  const { events, saved } = await runReply("text/markdown");
  assert.deepEqual(events.filter((event) => event.message_type.endsWith("message.delta") || event.message_type.endsWith("message.received")).map((event) => event.payload.content_type), ["text/markdown", "text/markdown"]);
  assert.equal(saved[0].payload.markdown_provenance, "owner-markdown-opt-in-v1");
});
