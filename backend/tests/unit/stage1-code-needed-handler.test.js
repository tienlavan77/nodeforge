import assert from "node:assert/strict";
import test from "node:test";
import { createStage1CodeNeededHandler } from "../../src/modules/workflows/stage1-code-needed-handler.js";

const response = { request_id: "22222222-2222-4222-8222-222222222222", type: "code_needed", role: "agent", payload: { files_requested: ["src/a.js", "src/missing.js"] } };
const requestEnvelope = { payload: { task_id: "FORGE-STAGE1-001", step_id: 1 } };
const newId = "33333333-3333-4333-8333-333333333333";

test("looks up files in Code Index and reads indexed content through File Service", async () => {
  const reads = []; const handler = createStage1CodeNeededHandler({ files: { findByPath: (path) => path === "src/a.js" ? { file_id: "F1", path, language: "javascript" } : null }, fileService: { readFile: async ({ path }) => { reads.push(path); return "export const a = 1;"; } }, createRequestId: () => newId, clock: () => new Date("2026-08-31T00:00:00Z") });
  const result = await handler.handleCodeNeeded(response, { requestEnvelope });
  assert.equal(result.type, "planning"); assert.equal(result.payload.expected_output.type, "planning"); assert.equal(result.payload.expected_submission, undefined); assert.equal(result.payload.task_context.instruction_blocks.some((block) => block.block_id === "stage1-conventions"), false); assert.equal(result.payload.task_context.instruction_blocks.some((block) => block.block_id === "planning"), true); assert.equal(result.parent_id, response.request_id); assert.deepEqual(reads, ["src/a.js"]); assert.deepEqual(result.payload.files[0].content, { type: "JavaScript/React source", role: "Repository source", exports: [], imports: [], components: [], functions: [], routes: [], jsx_elements: [], css_variables: [], dependencies: [], relationships: [], modification_points: [] }); assert.match(result.payload.files[0].before_checksum, /^sha256:[0-9a-f]{64}$/); assert.equal(result.payload.files[0].size_bytes, 19); assert.equal(result.payload.files[0].language, "javascript"); assert.equal(result.payload.files[0].exists, true); assert.equal(result.payload.files.length, 1);
});

test("rejects stale index checksum before providing content", async () => {
  const handler = createStage1CodeNeededHandler({ files: { findByPath: () => ({ path: "src/a.js", sha256: "sha256:" + "0".repeat(64) }) }, fileService: { readFile: async () => "changed" } });
  await assert.rejects(() => handler.handleCodeNeeded({ ...response, payload: { files_requested: ["src/a.js"] } }, { requestEnvelope }), (error) => error.code === "CONTEXT_STALE");
});

test("does not read an unindexed path", async () => {
  let called = false; const handler = createStage1CodeNeededHandler({ files: { findByPath: () => null }, fileService: { readFile: async () => { called = true; } } });
  await assert.rejects(() => handler.handleCodeNeeded({ ...response, payload: { files_requested: ["src/no.js"] } }, { requestEnvelope }), (error) => error.code === "CONTEXT_UNAVAILABLE");
  assert.equal(called, false);
});

test("selects structured_patch for an existing file over 3 KiB", async () => {
  const content = "x".repeat(4096);
  const handler = createStage1CodeNeededHandler({ files: { findByPath: () => ({ path: "src/large.js", language: "javascript", size_bytes: 4096, sha256: "sha256:" + "0".repeat(64) }) }, fileService: { readFile: async () => content } });
  await assert.rejects(() => handler.handleCodeNeeded({ ...response, payload: { files_requested: ["src/large.js"] } }, { requestEnvelope }), (error) => error.code === "CONTEXT_STALE");
});
