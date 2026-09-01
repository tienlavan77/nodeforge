import assert from "node:assert/strict";
import test from "node:test";
import { createStage1ResponseRouter } from "../../src/modules/workflows/stage1-response-router.js";

const base = { role: "agent", payload: {} };

test("routes code_needed and submit_code_response to their handlers", async () => {
  const calls = [];
  const router = createStage1ResponseRouter({ onCodeNeeded: async (envelope, context) => { calls.push(["needed", envelope, context]); return "provide"; }, onSubmitCode: async (envelope, context) => { calls.push(["submit", envelope, context]); return "review"; } });
  const context = { task_id: "FORGE-STAGE1-001" };
  assert.equal(await router.routeResponse({ ...base, type: "code_needed" }, context), "provide");
  assert.equal(await router.routeResponse({ ...base, type: "submit_code_response" }, context), "review");
  assert.deepEqual(calls.map(([kind]) => kind), ["needed", "submit"]);
  assert.equal(calls[0][2], context);
});

test("rejects unsupported and unvalidated response envelopes", async () => {
  const router = createStage1ResponseRouter({ onCodeNeeded() {}, onSubmitCode() {} });
  await assert.rejects(() => router.routeResponse({ ...base, type: "completed" }), /does not support/);
  await assert.rejects(() => router.routeResponse({ type: "code_needed", role: "node" }), /validated Agent envelope/);
});
