// Verifies direct System Engineer checkpoints survive restarts and reject uncertain tool replay.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createOwnerExecutionCheckpoint, executionDigest } from "../../src/application/owner-execution-checkpoint.js";
import { checkpointOwnerTools } from "../../src/application/owner-execution-tools.js";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";

// Creates an isolated project so checkpoint tests exercise durable File Service writes.
async function projectFixture() {
  const root = await mkdtemp(join(tmpdir(), "nf-owner-execution-"));
  return { root, files: createFileService({ projectRoot: root, logger: { error() {} } }) };
}

test("checkpoints record tool boundaries, persist session state, and reconcile edited files", async (context) => {
  const fixture = await projectFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const store = createOwnerExecutionCheckpoint({ fileService: fixture.files });
  await store.start({ conversationId: "C1", executionId: "E1", messageId: "M1", provider: "codex", promptHash: executionDigest("fix") });
  await store.patch("C1", "E1", { provider_thread_id: "thread-1" });
  const result = { path: "test.js", sha256: `sha256:${createHash("sha256").update("updated").digest("hex")}` };
  const tools = checkpointOwnerTools({ registry: { edit_diff: { execute: async () => { await fixture.files.atomicWrite({ path: "test.js", content: "updated", replace: true }); return result; } } }, checkpoint: store, conversationId: "C1", executionId: "E1", signal: new AbortController().signal });
  await tools.edit_diff.execute({ path: "test.js", before_checksum: "sha256:old", replacement: "updated" }, { changed_paths: ["test.js"] });
  await store.patch("C1", "E1", { status: "interrupted" });
  const restored = createOwnerExecutionCheckpoint({ fileService: fixture.files });
  const record = await restored.load("C1", "E1");
  assert.equal(record.provider_thread_id, "thread-1");
  assert.equal(record.completed_tool_calls[0].after_checksum, result.sha256);
  assert.equal(await restored.reconcile(record), true);
  await fixture.files.atomicWrite({ path: "test.js", content: "changed", replace: true });
  assert.equal(await restored.reconcile(record), false);
});

test("the System Engineer SDK persists the provider thread and Forge receipts before completion", async (context) => {
  const fixture = await projectFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const checkpoint = createOwnerExecutionCheckpoint({ fileService: fixture.files });
  const state = new Map();
  const conversationStateStore = {
    // Creates isolated chat state independently from the durable execution record.
    async create({ conversationId, agentId }) { if (!state.has(conversationId)) state.set(conversationId, { agent_id: agentId }); return state.get(conversationId); },
    // Loads the current chat thread for a System Engineer conversation.
    async get(conversationId) { return state.get(conversationId); },
    // Saves the provider session as soon as the SDK reports it.
    async update(conversationId, fields) { const next = { ...state.get(conversationId), ...fields }; state.set(conversationId, next); return next; }
  };
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ agent_id: "engineer", role: "system_engineer", provider: "codex" }) }, sdkGateways: { codex: { conversationMode: "thread", execute: async ({ onSessionReady, options }) => {
    onSessionReady("thread-1");
    await options.forgeTools.registry.git_status.execute({}, options.forgeTools.context);
    assert.equal((await checkpoint.load("C3", "E3")).provider_thread_id, "thread-1");
    return { text: "done" };
  } } }, fallbackStream: async function* () {}, executionCheckpoint: checkpoint, conversationStateStore, fileService: fixture.files, gitService: { status: async () => "", diffWorkingTree: async () => "" }, testService: { runCheck: async () => ({ status: "passed" }) }, projectRoot: fixture.root, projectLogger: () => {} });
  const chunks = [];
  for await (const chunk of stream({ agentId: "engineer", payload: { text: "inspect", message_id: "M3" }, correlationId: "E3", conversationId: "C3" })) chunks.push(chunk);
  assert.equal(chunks[0].text, "done");
  const record = await checkpoint.load("C3", "E3");
  assert.equal(record.status, "completed");
  assert.equal(record.completed_tool_calls[0].tool_name, "git_status");
  assert.equal(state.get("C3").sdk_thread_id, "thread-1");
});

test("completed commits require matching HEAD and cannot be repeated after continuation", async (context) => {
  const fixture = await projectFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  let head = "a".repeat(40);
  const store = createOwnerExecutionCheckpoint({ fileService: fixture.files, gitService: { getHead: async () => head } });
  await store.start({ conversationId: "C4", executionId: "E4", messageId: "M4", provider: "codex", promptHash: executionDigest("commit") });
  const step = await store.beforeTool("C4", "E4", "commit_changes", { message: "done" });
  await store.afterTool("C4", "E4", step, { sha: head });
  await store.patch("C4", "E4", { status: "interrupted" });
  assert.equal(await store.reconcile(await store.load("C4", "E4")), true);
  head = "b".repeat(40);
  assert.equal(await store.reconcile(await store.load("C4", "E4")), false);
  head = "a".repeat(40);
  await store.start({ conversationId: "C4", executionId: "E4", provider: "codex", promptHash: executionDigest("commit"), continueAttempt: true });
  await assert.rejects(store.beforeTool("C4", "E4", "commit_changes", { message: "done" }), /already completed/);
});

test("checkpoints reject uncertain commits and protect live conversation leases", async (context) => {
  const fixture = await projectFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const first = createOwnerExecutionCheckpoint({ fileService: fixture.files });
  const second = createOwnerExecutionCheckpoint({ fileService: fixture.files });
  await first.start({ conversationId: "C2", executionId: "E1", messageId: "M1", provider: "codex", promptHash: executionDigest("commit") });
  await assert.rejects(second.start({ conversationId: "C2", executionId: "E2", provider: "codex", promptHash: executionDigest("other") }), /already running/);
  await first.beforeTool("C2", "E1", "commit_changes", { message: "commit" });
  await first.patch("C2", "E1", { status: "interrupted" });
  assert.equal(await second.reconcile(await second.load("C2", "E1")), false);
  await assert.rejects(second.start({ conversationId: "C2", executionId: "E1", provider: "codex", promptHash: executionDigest("commit"), continueAttempt: true }), /manual workspace reconciliation/);
  assert.equal((await second.close("C2", "E1", "discarded")).status, "discarded");
});
