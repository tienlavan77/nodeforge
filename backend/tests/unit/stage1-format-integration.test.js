import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createStage1SubmitCodeHandler } from "../../src/modules/workflows/stage1-submit-code-handler.js";

const path = "ui/nextjs/app/FormatTarget.jsx";
const before = "export const marker = 'before';\n";
const beforeChecksum = `sha256:${createHash("sha256").update(before).digest("hex")}`;

function response(format, content) {
  return {
    request_id: "11111111-1111-4111-8111-111111111111",
    parent_id: "22222222-2222-4222-8222-222222222222",
    type: "submit_code_response",
    role: "agent",
    timestamp: "2026-09-01T00:00:00.000Z",
    payload: { explanation: "Update marker", files: [{ path, language: "javascript", format, content, exists: true, before_checksum: beforeChecksum }] }
  };
}

function harness({ read = before, failWrite = false } = {}) {
  let current = read;
  const writes = [];
  const status = { get: () => ({ ticket_id: "FORMAT-001", status: "running", version: 1 }), updateStatus: (_id, next) => ({ ticket_id: "FORMAT-001", status: next, version: 2 }) };
  const fileService = {
    readFile: async () => current,
    atomicWrite: async ({ content }) => { if (failWrite) throw new Error("write failed"); writes.push(content); current = content; },
    atomicCreate: async () => { throw new Error("unexpected create"); }
  };
  const handler = createStage1SubmitCodeHandler({ fileService, gitService: { commit: async () => ({ sha: "format-sha" }) }, statusStore: status });
  return { handler, writes };
}

test("materializes unified_diff through File Service and commits the result", async () => {
  const { handler, writes } = harness();
  const diff = `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-export const marker = 'before';\n+export const marker = 'after';\n`;
  const result = await handler.handleSubmitCode(response("unified_diff", diff), { taskId: "FORMAT-001", projectId: "PROJECT-NODEFORGE", contextFiles: [{ path, content: before, before_checksum: beforeChecksum }] });
  assert.equal(result.commit.sha, "format-sha");
  assert.deepEqual(writes, ["export const marker = 'after';\n"]);
});

test("materializes apply_patch with bare @@ context through File Service", async () => {
  const { handler, writes } = harness();
  const patch = `*** Begin Patch\n*** Update File: ${path}\n@@\n-export const marker = 'before';\n+export const marker = 'after';\n*** End Patch`;
  const result = await handler.handleSubmitCode(response("apply_patch", patch), { taskId: "FORMAT-001", projectId: "PROJECT-NODEFORGE", contextFiles: [{ path, content: before, before_checksum: beforeChecksum }] });
  assert.equal(result.commit.sha, "format-sha");
  assert.deepEqual(writes, ["export const marker = 'after';\n"]);
});

test("does not write when a patch cannot be applied", async () => {
  const { handler, writes } = harness();
  const invalid = `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-export const marker = 'wrong';\n+export const marker = 'after';\n`;
  await assert.rejects(() => handler.handleSubmitCode(response("unified_diff", invalid), { taskId: "FORMAT-001", projectId: "PROJECT-NODEFORGE", contextFiles: [{ path, content: before, before_checksum: beforeChecksum }] }), /Hunk context mismatch/);
  assert.deepEqual(writes, []);
});


test("materializes a strict structured patch sequentially through File Service", async () => {
  const { handler, writes } = harness();
  const patch = { operations: [
    { op: "replace_range", expected_content: "export const marker = 'before';", new_content: "export const marker = 'after';" },
    { op: "insert_after", anchor_text: "export const marker = 'after';", new_content: "\nexport const added = true;" }
  ] };
  await handler.handleSubmitCode(response("structured_patch", patch), { taskId: "FORMAT-001", projectId: "PROJECT-NODEFORGE", contextFiles: [{ path, content: before, before_checksum: beforeChecksum }] });
  assert.deepEqual(writes, ["export const marker = 'after';\nexport const added = true;\n"]);
});

test("rejects unused or nullable structured patch fields before writing", async () => {
  const { handler, writes } = harness();
  const patch = { operations: [{ op: "replace_range", expected_content: "export const marker = 'before';", new_content: "export const marker = 'after';", anchor_text: null }] };
  await assert.rejects(() => handler.handleSubmitCode(response("structured_patch", patch), { taskId: "FORMAT-001", projectId: "PROJECT-NODEFORGE" }), (error) => error.code === "INVALID_STRUCTURED_PATCH");
  assert.deepEqual(writes, []);
});

test("rejects duplicate file paths before materializing or writing", async () => {
  const { handler, writes } = harness();
  const patch = { operations: [{ op: "delete_range", expected_content: "export const marker = 'before';" }] };
  const duplicate = response("structured_patch", patch);
  duplicate.payload.files.push(structuredClone(duplicate.payload.files[0]));
  await assert.rejects(() => handler.handleSubmitCode(duplicate, { taskId: "FORMAT-001", projectId: "PROJECT-NODEFORGE" }), (error) => error.code === "DUPLICATE_FILE_PATH");
  assert.deepEqual(writes, []);
});
