import assert from "node:assert/strict";
import test from "node:test";
import { createStage1CodeNeededHandler } from "../../src/modules/workflows/stage1-code-needed-handler.js";

const response = { request_id: "22222222-2222-4222-8222-222222222222", type: "code_needed", role: "agent", payload: { files_requested: ["src/a.js", "src/missing.js"] } };
const requestEnvelope = { payload: { task_id: "FORGE-STAGE1-001", step_id: 1 } };
const newId = "33333333-3333-4333-8333-333333333333";

test("looks up files in Code Index and reads indexed content through File Service", async () => {
  const reads = []; const handler = createStage1CodeNeededHandler({ files: { findByPath: (path) => path === "src/a.js" ? { file_id: "F1", path, language: "javascript" } : null }, fileService: { readFile: async ({ path }) => { reads.push(path); return "export const a = 1;"; } }, createRequestId: () => newId, clock: () => new Date("2026-08-31T00:00:00Z") });
  const result = await handler.handleCodeNeeded(response, { requestEnvelope });
  assert.equal(result.type, "code_provide"); assert.equal(result.parent_id, response.request_id); assert.deepEqual(reads, ["src/a.js"]); assert.equal(result.payload.files[0].content, "export const a = 1;"); assert.match(result.payload.files[0].before_checksum, /^sha256:[0-9a-f]{64}$/); assert.equal(result.payload.files[0].size_bytes, 19); assert.equal(result.payload.files[1].exists, false); assert.equal(result.payload.files[1].content, null); assert.equal(result.payload.files[1].before_checksum, null);
});

test("rejects stale index checksum before providing content", async () => {
  const handler = createStage1CodeNeededHandler({ files: { findByPath: () => ({ path: "src/a.js", sha256: "sha256:" + "0".repeat(64) }) }, fileService: { readFile: async () => "changed" } });
  await assert.rejects(() => handler.handleCodeNeeded({ ...response, payload: { files_requested: ["src/a.js"] } }, { requestEnvelope }), (error) => error.code === "CONTEXT_STALE");
});

test("does not read an unindexed path", async () => {
  let called = false; const handler = createStage1CodeNeededHandler({ files: { findByPath: () => null }, fileService: { readFile: async () => { called = true; } } });
  const result = await handler.handleCodeNeeded({ ...response, payload: { files_requested: ["src/no.js"] } }, { requestEnvelope });
  assert.equal(result.payload.files[0].exists, false); assert.equal(called, false);
});
