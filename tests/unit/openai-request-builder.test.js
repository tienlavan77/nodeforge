import assert from "node:assert/strict";
import test from "node:test";
import { buildResponsesInput } from "../../src/modules/agent/provider-adapters/openai-request-builder.js";

test("places transcript blocks between cacheable developer and current user blocks", () => {
  const input = buildResponsesInput({ developer_blocks: [{ block_id: "rules", content: "rules", cacheable: true }], transcript_blocks: [{ block_id: "round_1", round: 1, instruction: "old", response_summary: "done", full_request_ref: "req", full_response_ref: "res", cacheable: false }], user_blocks: [{ block_id: "current", content: "now", cacheable: false }] });
  assert.equal(input[0].role, "developer");
  assert.equal(input[0].content[0].prompt_cache_breakpoint, true);
  assert.equal(input[1].role, "user");
  assert.equal(input[1].content[0].prompt_cache_breakpoint, undefined);
  assert.equal(input[2].role, "user");
});
