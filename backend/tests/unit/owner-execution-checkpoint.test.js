// Verifies direct System Engineer checkpoints survive restarts and reject uncertain tool replay.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createOwnerExecutionCheckpoint, executionDigest } from "../../src/application/owner-execution-checkpoint.js";
import { createOwnerExecutionControl } from "../../src/application/owner-execution-control.js";
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
  await store.markStopped("C1", "E1");
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
  await store.markStopped("C4", "E4");
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
  await first.markStopped("C2", "E1");
  assert.equal((await second.close("C2", "E1", "discarded")).status, "discarded");
});

test("a cancelled run_check clears its pending checkpoint only after its runner rejects on abort", async (context) => {
  const fixture = await projectFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const store = createOwnerExecutionCheckpoint({ fileService: fixture.files });
  const controller = new AbortController();
  await store.start({ conversationId: "C-check", executionId: "E-check", messageId: "M-check", provider: "codex", promptHash: executionDigest("check") });
  const tools = checkpointOwnerTools({ registry: { run_check: { execute: async (_input, { abortSignal }) => {
    controller.abort(Object.assign(new Error("Paused"), { code: "EXECUTION_PAUSED" }));
    throw abortSignal.reason;
  } } }, checkpoint: store, conversationId: "C-check", executionId: "E-check", signal: controller.signal });
  await assert.rejects(tools.run_check.execute({ type: "test" }), { code: "EXECUTION_PAUSED" });
  const pending = await store.load("C-check", "E-check");
  assert.equal(pending.pending_tool_calls.length, 0);
  assert.equal(pending.status, "running");
  assert.equal(pending.failed_tool_calls.at(-1).tool_name, "run_check");
  await store.patch("C-check", "E-check", { status: "interrupted" });
  await store.markStopped("C-check", "E-check");
  assert.equal(await store.reconcile(await store.load("C-check", "E-check")), true);
});

test("legacy run_check pending state settles from a later durable tool receipt without claiming success", async (context) => {
  const fixture = await projectFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const store = createOwnerExecutionCheckpoint({ fileService: fixture.files });
  await store.start({ conversationId: "C-legacy-check", executionId: "E-legacy-check", messageId: "M-legacy-check", provider: "codex", promptHash: executionDigest("check") });
  await store.patch("C-legacy-check", "E-legacy-check", { provider_thread_id: "thread-legacy" });
  const check = await store.beforeTool("C-legacy-check", "E-legacy-check", "run_check", { type: "test" });
  await store.failTool("C-legacy-check", "E-legacy-check", check, Object.assign(new Error("test failed"), { code: "TEST_FAILED" }));
  const later = await store.beforeTool("C-legacy-check", "E-legacy-check", "search_tree", {});
  await store.afterTool("C-legacy-check", "E-legacy-check", later, { matches: [] });
  await store.patch("C-legacy-check", "E-legacy-check", { status: "interrupted" });
  const control = createOwnerExecutionControl({ checkpoint: store, sdkStream: { isActive: () => false }, agentConfiguration: { getById: () => ({ role: "system_engineer" }) }, communications: { getById: () => ({ id: "M-legacy-check", conversation_id: "C-legacy-check", recipient: { id: "engineer" } }) } });
  const [visible] = await control.list("C-legacy-check", "engineer");
  const record = await store.load("C-legacy-check", "E-legacy-check");
  assert.equal(record.pending_tool_calls.length, 0);
  assert.deepEqual(record.settled_tool_calls.map(({ outcome, evidence_sequence }) => [outcome, evidence_sequence]), [["failed", later.sequence]]);
  assert.equal(record.runner_stop_evidence, "no_active_sdk_runner_or_pending_mutation");
  assert.equal(visible.can_continue, true);
  assert.equal(await store.reconcile(record), true);
});

test("restart inherits verified file and commit evidence without replaying completed mutations", async (context) => {
  const fixture = await projectFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const head = "a".repeat(40);
  const store = createOwnerExecutionCheckpoint({ fileService: fixture.files, gitService: { getHead: async () => head } });
  await store.start({ conversationId: "C5", executionId: "E5", messageId: "M5", provider: "codex", promptHash: executionDigest("fix") });
  const editInput = { path: "test.js", before_checksum: "sha256:old" };
  const edit = await store.beforeTool("C5", "E5", "edit_diff", editInput);
  await fixture.files.atomicWrite({ path: "test.js", content: "fixed", replace: true });
  await store.afterTool("C5", "E5", edit, { sha256: `sha256:${createHash("sha256").update("fixed").digest("hex")}` }, ["test.js"]);
  const commit = await store.beforeTool("C5", "E5", "commit_changes", { message: "fix" });
  await store.afterTool("C5", "E5", commit, { sha: head });
  await store.patch("C5", "E5", { status: "interrupted" });
  await store.markStopped("C5", "E5");
  const restarted = await store.start({ conversationId: "C5", executionId: "E6", messageId: "M5", provider: "codex", promptHash: executionDigest("fix"), resumeOf: "E5" });
  assert.equal(restarted.lineage_id, "E5");
  assert.equal(restarted.attempt_number, 2);
  assert.equal(restarted.resume_of, "E5");
  assert.equal(restarted.next_sequence, 3);
  assert.deepEqual(restarted.changed_paths, ["test.js"]);
  assert.equal(restarted.completed_tool_calls.length, 2);
  assert.equal((await store.load("C5", "E5")).status, "restarted");
  await assert.rejects(store.beforeTool("C5", "E6", "edit_diff", editInput), /already completed/);
  await assert.rejects(store.beforeTool("C5", "E6", "commit_changes", { message: "different" }), /already completed/);
});

test("System Engineer Continue resumes the saved thread without replaying the original prompt", async (context) => {
  const fixture = await projectFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const checkpoint = createOwnerExecutionCheckpoint({ fileService: fixture.files });
  const text = "Produce a unique system report";
  const logs = [];
  await checkpoint.start({ conversationId: "C-continue", executionId: "E-continue", messageId: "M-continue", provider: "codex", promptHash: executionDigest(text) });
  await checkpoint.patch("C-continue", "E-continue", { status: "interrupted", provider_thread_id: "thread-saved" });
  await checkpoint.markStopped("C-continue", "E-continue");
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ agent_id: "engineer", role: "system_engineer", provider: "codex" }) }, sdkGateways: { codex: { conversationMode: "thread", execute: async ({ resumeThreadId, prompt }) => {
    assert.equal(resumeThreadId, "thread-saved");
    assert.match(prompt, /Continue the interrupted request/);
    assert.doesNotMatch(prompt, /Produce a unique system report/);
    return { text: "continued", thread_id: "thread-saved" };
  } } }, fallbackStream: async function* () {}, executionCheckpoint: checkpoint, conversationStateStore: { create: async () => ({ agent_id: "engineer", sdk_provider: "codex", sdk_thread_id: "wrong-thread" }), update: async () => {} }, fileService: fixture.files, gitService: { status: async () => "", diffWorkingTree: async () => "" }, testService: { runCheck: async () => ({ status: "passed" }) }, projectRoot: fixture.root, projectLogger: (event) => logs.push(event) });
  for await (const chunk of stream({ agentId: "engineer", payload: { text, message_id: "M-continue", continue_execution: true }, correlationId: "E-continue", conversationId: "C-continue" })) assert.equal(chunk.text, "continued");
  assert.equal((await checkpoint.load("C-continue", "E-continue")).status, "completed");
  const started = logs.find((event) => event.event_name === "owner.sdk_request_started");
  assert.match(started.message, /Continue started after checkpoint step 0/);
  assert.equal(started.payload.recovery_mode, "continue");
  assert.equal(started.payload.provider_session_resumed, true);
});

test("restart opens a new provider thread with inherited checkpoint context", async (context) => {
  const fixture = await projectFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const checkpoint = createOwnerExecutionCheckpoint({ fileService: fixture.files });
  await checkpoint.start({ conversationId: "C6", executionId: "E6", messageId: "M6", provider: "codex", promptHash: executionDigest("inspect") });
  const step = await checkpoint.beforeTool("C6", "E6", "git_status", {});
  await checkpoint.afterTool("C6", "E6", step, { status: "clean" });
  await checkpoint.patch("C6", "E6", { status: "interrupted", provider_thread_id: "old-thread" });
  await checkpoint.markStopped("C6", "E6");
  const state = { agent_id: "engineer", sdk_provider: "codex", sdk_thread_id: "old-thread", sdk_history: [{ role: "Assistant", text: "old transcript" }] };
  const conversationStateStore = { create: async () => state, update: async (_conversationId, fields) => Object.assign(state, fields) };
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ agent_id: "engineer", role: "system_engineer", provider: "codex" }) }, sdkGateways: { codex: { conversationMode: "thread", execute: async ({ prompt, resumeThreadId }) => {
    assert.equal(resumeThreadId, undefined);
    assert.match(prompt, /"lineage_id":"E6"/);
    assert.match(prompt, /"tool_name":"git_status"/);
    assert.doesNotMatch(prompt, /old transcript/);
    return { text: "done" };
  } } }, fallbackStream: async function* () {}, executionCheckpoint: checkpoint, conversationStateStore, fileService: fixture.files, gitService: { status: async () => "", diffWorkingTree: async () => "" }, testService: { runCheck: async () => ({ status: "passed" }) }, projectRoot: fixture.root, projectLogger: () => {} });
  for await (const chunk of stream({ agentId: "engineer", payload: { text: "inspect", message_id: "M6", resume_of: "E6" }, correlationId: "E7", conversationId: "C6" })) assert.equal(chunk.text, "done");
  assert.equal((await checkpoint.load("C6", "E7")).completed_tool_calls.length, 1);
});
