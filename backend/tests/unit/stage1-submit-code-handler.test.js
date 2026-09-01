import assert from "node:assert/strict";
import test from "node:test";
import { createStage1SubmitCodeHandler } from "../../src/modules/workflows/stage1-submit-code-handler.js";

const response = { request_id: "22222222-2222-4222-8222-222222222222", parent_id: "11111111-1111-4111-8111-111111111111", type: "submit_code_response", role: "agent", payload: { files: [{ path: "tests/fixtures/new.txt", language: "text", format: "full_content", content: "new\n", exists: false, before_checksum: null, summary: "Provides a new test fixture module." }, { path: "src/existing.js", language: "javascript", format: "full_content", content: "export {};\n", exists: true, before_checksum: "sha256:7992a39d6cde5e050eb78461a8bf9ad986175a94826e835c110b3967290bd249" }] } };
function setup() { const writes = []; const commits = []; const fileService = { readFile: async ({ path }) => path === "src/existing.js" ? "export {}\n" : "", atomicCreate: async (input) => writes.push({ op: "create", ...input }), atomicWrite: async (input) => writes.push({ op: "write", ...input }) }; const gitService = { commit: async (message, options) => { commits.push({ message, options }); return { sha: "abc" }; } }; const current = { ticket_id: "FORGE-STAGE1-001", status: "running" }; const statusStore = { get: () => current, updateStatus: (_id, status, details) => ({ ...current, status, details }) }; return { writes, commits, handler: createStage1SubmitCodeHandler({ fileService, gitService, statusStore }) }; }

test("writes full submissions through File Service and commits explicit paths", async () => { const { handler, writes, commits } = setup(); const result = await handler.handleSubmitCode(response, { taskId: "FORGE-STAGE1-001", ticketId: "FORGE-STAGE1-001" }); assert.deepEqual(writes.map(({ op }) => op), ["create", "write"]); assert.deepEqual(commits[0].options.paths, ["tests/fixtures/new.txt", "src/existing.js"]); assert.equal(result.status.status, "reviewing"); });

test("rejects non-full format before writing", async () => { const { handler, writes } = setup(); await assert.rejects(() => handler.handleSubmitCode({ ...response, payload: { files: [{ ...response.payload.files[0], format: "unified_diff" }] } }, { taskId: "FORGE-STAGE1-001" }), (error) => error.code === "SUBMISSION_FORMAT_UNSUPPORTED"); assert.equal(writes.length, 0); });

test("rejects a truncated full-file submission before writing", async () => {
  const { handler, writes } = setup();
  await assert.rejects(() => handler.handleSubmitCode({ ...response, payload: { files: [{ ...response.payload.files[1], content: "stub" }] } }, { taskId: "FORGE-STAGE1-001", contextFiles: [{ path: "src/existing.js", content: "x".repeat(4096), before_checksum: response.payload.files[1].before_checksum }] }), (error) => error.code === "SUBMISSION_TRUNCATED");
  assert.equal(writes.length, 0);
});

test("does not update status when commit fails", async () => { let updated = false; const handler = createStage1SubmitCodeHandler({ fileService: { atomicCreate: async () => {}, atomicWrite: async () => {} }, gitService: { commit: async () => { throw new Error("commit failed"); } }, statusStore: { get: () => ({ status: "running" }), updateStatus: () => { updated = true; } } }); await assert.rejects(() => handler.handleSubmitCode({ ...response, payload: { files: [response.payload.files[0]] } }, { taskId: "FORGE-STAGE1-001" }), /commit failed/); assert.equal(updated, false); });

test("rejects an existing file when before_checksum does not match", async () => {
  let writes = 0;
  const handler = createStage1SubmitCodeHandler({ fileService: { readFile: async () => "current\n", atomicCreate: async () => { writes += 1; }, atomicWrite: async () => { writes += 1; } }, gitService: { commit: async () => ({ sha: "never" }) } });
  await assert.rejects(() => handler.handleSubmitCode({ ...response, payload: { files: [{ path: "src/existing.js", language: "javascript", format: "full_content", content: "replacement\n", exists: true, before_checksum: "sha256:" + "0".repeat(64) }] } }, { taskId: "FORGE-STAGE1-001" }), (error) => error.code === "CHECKSUM_MISMATCH");
  assert.equal(writes, 0);
});

test("rejects a new file that declares a non-null before_checksum", async () => {
  const { handler, writes } = setup();
  await assert.rejects(() => handler.handleSubmitCode({ ...response, payload: { files: [{ ...response.payload.files[0], before_checksum: "sha256:" + "0".repeat(64) }] } }, { taskId: "FORGE-STAGE1-001" }), (error) => error.code === "CHECKSUM_MISMATCH");
  assert.equal(writes.length, 0);
});

test("rejects a new file without summary before writing", async () => {
  const { handler, writes } = setup();
  const file = { ...response.payload.files[0] };
  delete file.summary;
  await assert.rejects(() => handler.handleSubmitCode({ ...response, payload: { files: [file] } }, { taskId: "FORGE-STAGE1-001" }), (error) => error.code === "INVALID_PAYLOAD");
  assert.equal(writes.length, 0);
});
