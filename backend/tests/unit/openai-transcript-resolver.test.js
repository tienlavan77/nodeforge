import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAITranscriptResolver } from "../../src/modules/agent/provider-adapters/openai-transcript-resolver.js";

test("OpenAI transcript resolver expands in-window refs and summarizes older rounds", async () => {
  const records = new Map([
    ["task/T/round_2/request", { request_id: "request-2", parent_id: "request-1", payload: { text: "next" } }],
    ["task/T/round_2/response", { request_id: "response-2", parent_id: "request-2", payload: { status: "ok" } }]
  ]);
  const storage = { get: async (ref) => ({ ref, data: records.get(ref) }) };
  const resolver = createOpenAITranscriptResolver({ storage });
  const result = await resolver.resolveTranscript({
    conversation_mode: "hybrid",
    hybrid_window: 1,
    transcript_blocks: [
      { block_id: "round_2", round: 2, instruction: "continue", response_summary: "new", full_request_ref: "task/T/round_2/request", full_response_ref: "task/T/round_2/response", in_window: true, cacheable: false },
      { block_id: "round_1", round: 1, instruction: "start", response_summary: "first\n response", full_request_ref: "task/T/round_1/request", full_response_ref: "task/T/round_1/response", in_window: false, cacheable: true }
    ]
  });
  assert.deepEqual(result.map(({ round }) => round), [1, 2]);
  assert.equal(result[0].text, "first response");
  assert.equal(result[1].full_request.request_id, "request-2");
  assert.equal(result[1].full_response.parent_id, "request-2");
});

test("OpenAI transcript resolver fails loudly for missing storage records", async () => {
  const resolver = createOpenAITranscriptResolver({ storage: { get: async () => { const error = new Error("missing"); error.code = "STORAGE_NOT_FOUND"; throw error; } } });
  await assert.rejects(() => resolver.resolveTranscript({ conversation_mode: "full_transcript", transcript_blocks: [{ block_id: "round_1", round: 1, instruction: "", response_summary: "", full_request_ref: "task/T/round_1/request", full_response_ref: "task/T/round_1/response", in_window: true, cacheable: false }] }), (error) => error.code === "TRANSCRIPT_RESOLVE_FAILED" && error.cause.code === "STORAGE_NOT_FOUND");
});

test("OpenAI transcript resolver validates configuration and payload", async () => {
  assert.throws(() => createOpenAITranscriptResolver(), /Protocol Storage/);
  const resolver = createOpenAITranscriptResolver({ storage: { get: async () => ({ data: {} }) } });
  await assert.rejects(() => resolver.resolveTranscript({ conversation_mode: "hybrid", transcript_blocks: [] }), (error) => error.code === "TRANSCRIPT_INVALID");
});
