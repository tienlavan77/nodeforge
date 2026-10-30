/**
 * Keeps architecture document authoring independent of source comment conventions.
 * Exercises actual Forge write/edit tools through durable execution checkpoints so
 * rejected input can be corrected without confusing it with an uncertain disk write.
 * Source comment rules, lease ownership and recovery of uncertain mutations remain enforced.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createOwnerExecutionCheckpoint, executionDigest } from "../../src/application/owner-execution-checkpoint.js";
import { checkpointOwnerTools } from "../../src/application/owner-execution-tools.js";
import { createWriteDiffTool, createEditDiffTool } from "../../src/tools/governance/agent-lifecycle-tools.js";

// Supplies a real isolated workspace and owned execution for testing document recovery without runtime edits.
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "nf-document-validation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const files = createFileService({ projectRoot: root, logger: { error() {} } });
  const checkpoint = createOwnerExecutionCheckpoint({ fileService: files, role: "architecture_manager" });
  await checkpoint.start({ conversationId: "conversation", executionId: "execution", messageId: "message", provider: "anthropic", promptHash: executionDigest("Document the decision") });
  return { root, files, checkpoint };
}

// Computes the whole-file revision expected by Forge edits rather than bypassing checksum validation.
function checksum(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

// Wraps real lifecycle tools so assertions cover the same error and receipt boundary used by AM chat.
function toolsFor(checkpoint, registry) {
  return checkpointOwnerTools({ registry, checkpoint, conversationId: "conversation", executionId: "execution", signal: new AbortController().signal });
}

test("AM and Coder write and edit Markdown without source comments, including fenced code", async (context) => {
  const { root, files } = await fixture(context);
  for (const role of ["architecture_manager", "coder"]) {
    for (const extension of ["md", "MD", "markdown"]) {
      const path = `docs/architecture/${role}.${extension}`;
      const toolContext = { agent_identity: { role }, allowed_prefixes: ["docs/architecture/"], project_root: root };
      const content = "Architecture decision\n\n```js\nfunction example() {}\n```\n";
      const write = createWriteDiffTool({ fileService: files });
      const result = await write.execute({ path, before_checksum: null, content }, toolContext);
      assert.equal(await files.readFile({ path }), content);
      assert.doesNotMatch(result.content[0].text, /Convention reminder|summary comment/);
      const replacement = "function anotherExample() {}";
      const edit = await createEditDiffTool({ fileService: files }).execute({ path, before_checksum: checksum(content), anchor: "function example() {}", replacement }, toolContext);
      const updated = content.replace("function example() {}", replacement);
      assert.equal(await files.readFile({ path }), updated);
      assert.equal(edit.reminder, undefined);
      await write.execute({ path, before_checksum: checksum(updated), content }, toolContext);
      assert.equal(await files.readFile({ path }), content);
    }
  }
});

test("source comments and JSON validity still reject input before writing", async (context) => {
  const { root, files } = await fixture(context);
  const write = createWriteDiffTool({ fileService: files });
  const toolContext = { agent_identity: { role: "coder" }, project_root: root };
  for (const [path, content, code] of [
    ["new.js", "const value = 1;", "SUMMARY_REQUIRED"],
    ["new-function.js", "// Explains the module.\nfunction undocumented() {}", "SUMMARY_REQUIRED"],
    ["invalid.json", "{", "CONTENT_INVALID"]
  ]) {
    await assert.rejects(write.execute({ path, before_checksum: null, content }, toolContext), { code, mutation_started: false });
    await assert.rejects(files.readFile({ path }), { code: "ENOENT" });
  }
  await files.atomicWrite({ path: "existing.js", content: "// Explains the module.\nconst value = 1;", replace: true });
  const before = await files.readFile({ path: "existing.js" });
  await assert.rejects(createEditDiffTool({ fileService: files }).execute({ path: "existing.js", before_checksum: checksum(before), anchor: "const value = 1;", replacement: "function undocumented() {}" }, toolContext), { code: "SUMMARY_REQUIRED", mutation_started: false });
  assert.equal(await files.readFile({ path: "existing.js" }), before);
});

test("rejected AM write leaves the execution active and accepts a corrected request", async (context) => {
  const { files, checkpoint } = await fixture(context);
  const tools = toolsFor(checkpoint, { write_diff: createWriteDiffTool({ fileService: files, maxLines: 1 }) });
  const path = "docs/architecture/decision.md";
  await assert.rejects(tools.write_diff.execute({ path, before_checksum: null, content: "First line\nSecond line" }), { code: "CONTENT_TOO_LARGE", mutation_started: false });
  await assert.rejects(files.readFile({ path }), { code: "ENOENT" });
  const rejected = await checkpoint.load("conversation", "execution");
  assert.equal(rejected.status, "running");
  assert.equal(rejected.active_mutations, 0);
  assert.deepEqual(rejected.pending_tool_calls, []);
  assert.equal(rejected.failed_tool_calls[0].error_code, "CONTENT_TOO_LARGE");
  await checkpoint.patch("conversation", "execution", { provider_thread_id: "retained-session" });
  await tools.write_diff.execute({ path, before_checksum: null, content: "Accepted decision" });
  await checkpoint.patch("conversation", "execution", { status: "completed" });
  const done = await checkpoint.load("conversation", "execution");
  assert.equal(done.status, "completed");
  assert.equal(done.completed_tool_calls.length, 1);
  assert.equal(await files.readFile({ path }), "Accepted decision");
});

test("rejected AM edit preserves bytes and permits correction within the same invocation", async (context) => {
  const { files, checkpoint } = await fixture(context);
  const path = "docs/architecture/edit.md";
  await files.atomicWrite({ path, content: "Before", replace: true });
  const tools = toolsFor(checkpoint, { edit_diff: createEditDiffTool({ fileService: files, maxChars: 12 }) });
  const input = { path, before_checksum: checksum("Before"), anchor: "Before" };
  await assert.rejects(tools.edit_diff.execute({ ...input, replacement: "Exceeds edit budget" }), { code: "CONTENT_TOO_LARGE", mutation_started: false });
  assert.equal(await files.readFile({ path }), "Before");
  assert.equal((await checkpoint.load("conversation", "execution")).status, "running");
  await checkpoint.patch("conversation", "execution", {});
  await tools.edit_diff.execute({ ...input, replacement: "After" });
  assert.equal(await files.readFile({ path }), "After");
  assert.deepEqual((await checkpoint.load("conversation", "execution")).pending_tool_calls, []);
});

test("post-write failures retain uncertain mutations even when the error code resembles validation", async (context) => {
  const { files, checkpoint } = await fixture(context);
  const path = "docs/architecture/uncertain.md";
  const diskFailure = Object.assign(new Error("Receipt delivery failed"), { code: "SUMMARY_REQUIRED" });
  const tools = toolsFor(checkpoint, { write_diff: createWriteDiffTool({ fileService: {
    readFile: (input) => files.readFile(input),
    // Simulates a write that reached disk but lost its acknowledgement before returning to Forge.
    atomicWrite: async (input) => { await files.atomicWrite(input); throw diskFailure; }
  } }) });
  await assert.rejects(tools.write_diff.execute({ path, before_checksum: null, content: "Written decision" }), diskFailure);
  assert.equal(await files.readFile({ path }), "Written decision");
  const uncertain = await checkpoint.load("conversation", "execution");
  assert.equal(uncertain.status, "manual_required");
  assert.equal(uncertain.pending_tool_calls.length, 1);
  await assert.rejects(checkpoint.beforeTool("conversation", "execution", "read_file", { path }), { code: "EXECUTION_INTERRUPTED" });
});

test("validation recovery does not transfer a live execution to another instance", async (context) => {
  const { files, checkpoint } = await fixture(context);
  const other = createOwnerExecutionCheckpoint({ fileService: files, role: "architecture_manager" });
  await assert.rejects(other.patch("conversation", "execution", {}), { code: "EXECUTION_BUSY" });
  assert.equal((await checkpoint.load("conversation", "execution")).status, "running");
});
