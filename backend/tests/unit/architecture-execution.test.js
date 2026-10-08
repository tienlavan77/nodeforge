// Guards Architecture pause/recovery records from System Engineer tools and cross-agent reads.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createOwnerExecutionCheckpoint, executionDigest } from "../../src/application/owner-execution-checkpoint.js";
import { createOwnerExecutionControl } from "../../src/application/owner-execution-control.js";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";
import { createForgeV1ConversationRoutes } from "../../src/transport/http/forge-v1-conversation-routes.js";
import { createPlanOwnerAuth } from "../../src/modules/governance/plan-owner-auth.js";

// Creates separate durable records for Architecture and System Engineer attempts.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nf-architecture-execution-"));
  const fileService = createFileService({ projectRoot: root, logger: { error() {} } });
  return { root, fileService, architecture: createOwnerExecutionCheckpoint({ fileService, root: ".forge/runtime/architecture-executions", role: "architecture_manager" }), engineer: createOwnerExecutionCheckpoint({ fileService }) };
}

test("Architecture execution keeps its own lineage and cannot call Git mutations", async (context) => {
  const { root, architecture, engineer } = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await architecture.start({ conversationId: "C1", executionId: "E1", messageId: "M1", provider: "codex", promptHash: executionDigest("plan") });
  assert.equal(await engineer.load("C1", "E1"), null);
  await assert.rejects(architecture.beforeTool("C1", "E1", "commit_changes", {}), { code: "TOOL_FORBIDDEN" });
  const step = await architecture.beforeTool("C1", "E1", "write_diff", { path: "workflows/plan.md", before_checksum: null, content: "new plan" });
  await architecture.failTool("C1", "E1", step, Object.assign(new Error("lost receipt"), { code: "LOST_RECEIPT" }));
  const record = await architecture.load("C1", "E1");
  assert.equal(record.status, "manual_required");
  assert.equal(record.pending_tool_calls.length, 1);
  assert.equal(await architecture.reconcile(record), false);
  await assert.rejects(architecture.start({ conversationId: "C1", executionId: "E2", messageId: "M2", provider: "codex", promptHash: executionDigest("next") }), { code: "EXECUTION_DECISION_REQUIRED" });
});

// Prevents Discard from hiding uncertain writes or a still-running Architecture agent.
test("discard keeps uncertain mutations and requires a stopped Architecture runner", async (context) => {
  const { root, architecture } = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await architecture.start({ conversationId: "discard", executionId: "attempt", messageId: "source", provider: "codex", promptHash: executionDigest("plan") });
  await architecture.patch("discard", "attempt", { status: "interrupted" });
  await assert.rejects(architecture.close("discard", "attempt", "discarded"), { code: "EXECUTION_RECONCILIATION_REQUIRED" });
  await architecture.markStopped("discard", "attempt");
  await architecture.close("discard", "attempt", "discarded");
  assert.equal((await architecture.load("discard", "attempt")).status, "discarded");
  await architecture.start({ conversationId: "discard", executionId: "pending", messageId: "source-2", provider: "codex", promptHash: executionDigest("write") });
  await architecture.beforeTool("discard", "pending", "write_diff", { path: "workflows/pending.md", before_checksum: null, content: "pending" });
  await architecture.patch("discard", "pending", { status: "interrupted" });
  await assert.rejects(architecture.close("discard", "pending", "discarded"), { code: "EXECUTION_RECONCILIATION_REQUIRED" });
});

test("Architecture execution list and decisions only return the selected agent's records", async (context) => {
  const { root, architecture, engineer } = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await architecture.start({ conversationId: "C2", executionId: "E2", messageId: "M2", provider: "codex", promptHash: executionDigest("plan") });
  await architecture.patch("C2", "E2", { status: "interrupted" });
  const messages = new Map([["M2", { id: "M2", conversation_id: "C2", recipient: { id: "architect" }, payload: { text: "plan" } }]]);
  const control = createOwnerExecutionControl({ checkpoint: engineer, architectureCheckpoint: architecture, agentConfiguration: { getById: (agentId) => ({ role: agentId === "architect" ? "architecture_manager" : "system_engineer" }) }, communications: { getById: (messageId) => messages.get(messageId) }, sdkStream: { pause: () => false }, ownerChatService: { replay: () => { throw new Error("unexpected replay"); } } });
  const [visible] = await control.list("C2", "architect");
  assert.deepEqual(visible, { conversation_id: "C2", execution_id: "E2", status: "interrupted", can_continue: false, can_reconcile: false, requires_human_review: false });
  assert.deepEqual(await control.list("C2", "engineer"), []);
  await assert.rejects(control.pause("C2", "E2", "engineer"), { statusCode: 404 });
  await assert.rejects(control.decide("C2", "E2", "engineer", "continue"), { statusCode: 404 });
  assert.equal(control.requiresOwnerAuth("architect"), true);
  assert.equal(control.requiresOwnerAuth("engineer"), false);
});

test("Architecture Continue preserves provider thread without resending the original request", async (context) => {
  const { root, fileService, architecture } = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const text = "Create a unique architecture plan";
  await architecture.start({ conversationId: "C-resume", executionId: "E-resume", messageId: "M-resume", provider: "codex", promptHash: executionDigest(text) });
  await architecture.patch("C-resume", "E-resume", { status: "interrupted", provider_thread_id: "thread-resume" });
  let executeCalls = 0;
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ agent_id: "architect", role: "architecture_manager", provider: "codex" }) }, sdkGateways: { codex: { conversationMode: "thread", execute: async ({ prompt, resumeThreadId }) => {
    executeCalls += 1;
    assert.equal(resumeThreadId, "thread-resume");
    assert.match(prompt, /Continue the interrupted request/);
    assert.doesNotMatch(prompt, /Create a unique architecture plan/);
    return { text: "continued", thread_id: "thread-resume" };
  } } }, fallbackStream: async function* () {}, architectureCheckpoint: architecture, conversationStateStore: { create: async () => ({ agent_id: "architect", sdk_provider: "codex", sdk_thread_id: "unrelated-thread" }), update: async () => {} }, fileService, projectRoot: root, projectLogger: () => {} });
  for await (const chunk of stream({ agentId: "architect", payload: { text, message_id: "M-resume", continue_execution: true }, correlationId: "E-resume", conversationId: "C-resume" })) assert.equal(chunk.text, "continued");
  assert.equal(executeCalls, 1);
  assert.equal((await architecture.load("C-resume", "E-resume")).status, "completed");
});

test("Architecture Continue refuses missing provider session instead of replaying the user request", async (context) => {
  const { root, architecture } = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await architecture.start({ conversationId: "C-lost", executionId: "E-lost", messageId: "M-lost", provider: "codex", promptHash: executionDigest("plan") });
  await architecture.patch("C-lost", "E-lost", { status: "interrupted" });
  const control = createOwnerExecutionControl({ architectureCheckpoint: architecture, agentConfiguration: { getById: () => ({ role: "architecture_manager" }) }, communications: { getById: () => ({ id: "M-lost", conversation_id: "C-lost", recipient: { id: "architect" }, payload: { text: "plan" } }) }, ownerChatService: { replay: () => { throw new Error("replayed without provider session"); } } });
  await assert.rejects(control.decide("C-lost", "E-lost", "architect", "continue"), { code: "EXECUTION_SESSION_UNAVAILABLE", statusCode: 409 });
  assert.equal((await architecture.load("C-lost", "E-lost")).status, "interrupted");
});

test("pending Architecture write is reconciled only against its original intended hash after runner exit", async (context) => {
  const { root, fileService, architecture } = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await architecture.start({ conversationId: "C3", executionId: "E3", messageId: "M3", provider: "codex", promptHash: executionDigest("draft") });
  const input = { path: "workflows/draft.md", before_checksum: null, content: "expected" };
  const step = await architecture.beforeTool("C3", "E3", "write_diff", input);
  await architecture.failTool("C3", "E3", step, new Error("response lost"));
  await assert.rejects(architecture.reconcilePending("C3", "E3", step.sequence, "owner"), { code: "EXECUTION_RECONCILIATION_REQUIRED" });
  await architecture.markStopped("C3", "E3");
  await fileService.atomicWrite({ path: input.path, content: "wrong", replace: true });
  await assert.rejects(architecture.reconcilePending("C3", "E3", step.sequence, "owner"), { code: "EXECUTION_RECONCILIATION_REQUIRED" });
  await fileService.atomicWrite({ path: input.path, content: input.content, replace: true });
  const reconciled = await architecture.reconcilePending("C3", "E3", step.sequence, "owner");
  assert.equal(reconciled.status, "interrupted");
  assert.equal(reconciled.manual_reconciliations[0].reconciled_by, "owner");
  assert.equal(reconciled.pending_tool_calls.length, 0);
  assert.equal(await architecture.reconcile(reconciled), true);
  await architecture.start({ conversationId: "C3", executionId: "E3", provider: "codex", promptHash: executionDigest("draft"), continueAttempt: true });
  await assert.rejects(architecture.beforeTool("C3", "E3", "write_diff", input), { code: "EXECUTION_RECONCILIATION_REQUIRED" });
});

test("pending delete requires physical absence; an active stale write cannot be reconciled", async (context) => {
  const { root, fileService, architecture } = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await fileService.atomicWrite({ path: "workflows/obsolete.md", content: "obsolete", replace: true });
  const before = `sha256:${createHash("sha256").update("obsolete").digest("hex")}`;
  await architecture.start({ conversationId: "C4", executionId: "E4", messageId: "M4", provider: "codex", promptHash: executionDigest("remove") });
  const step = await architecture.beforeTool("C4", "E4", "delete_file", { path: "workflows/obsolete.md", before_checksum: before });
  await architecture.failTool("C4", "E4", step, new Error("response lost"));
  await architecture.markStopped("C4", "E4");
  await assert.rejects(architecture.reconcilePending("C4", "E4", step.sequence, "owner"), { code: "EXECUTION_RECONCILIATION_REQUIRED" });
  await rm(join(root, "workflows/obsolete.md"));
  const reconciled = await architecture.reconcilePending("C4", "E4", step.sequence, "owner");
  assert.equal(await architecture.reconcile(reconciled), true);

  await architecture.start({ conversationId: "C5", executionId: "E5", messageId: "M5", provider: "codex", promptHash: executionDigest("write") });
  const active = await architecture.beforeTool("C5", "E5", "write_diff", { path: "workflows/active.md", before_checksum: null, content: "active" });
  await architecture.patch("C5", "E5", { status: "manual_required" });
  await architecture.markStopped("C5", "E5");
  assert.equal((await architecture.load("C5", "E5")).runner_stopped_at, undefined);
  await assert.rejects(architecture.reconcilePending("C5", "E5", active.sequence, "owner"), { code: "EXECUTION_RECONCILIATION_REQUIRED" });
});

test("Architecture execution controls require server-side owner authorization", async () => {
  const calls = [];
  const control = {
    requiresOwnerAuth: () => true,
    list: async (...argumentsList) => { calls.push(["list", ...argumentsList]); return []; },
    pause: async (...argumentsList) => { calls.push(["pause", ...argumentsList]); return {}; },
    decide: async (...argumentsList) => { calls.push(["decide", ...argumentsList]); return {}; },
    reconcilePending: async (...argumentsList) => { calls.push(["reconcile", ...argumentsList]); return {}; }
  };
  const routes = createForgeV1ConversationRoutes({ conversationCrudService: { get: () => ({ project_id: "PROJECT", agent_id: "architect" }) }, ownerExecutionControl: control, planOwnerAuth: createPlanOwnerAuth({ token: "secret", ownerId: "OWNER" }) });
  // Sends an execution request through the transport route without a live HTTP listener.
  function request(method, path, projectId, authorization, body = {}) {
    return routes.routeConversation({ method, parts: path.split("/"), url: new URL("http://localhost"), projectId, headers: authorization ? { authorization } : {}, body });
  }
  await assert.rejects(request("GET", "conversations/C/executions", "OTHER"), { statusCode: 404 });
  await assert.rejects(request("POST", "conversations/C/executions/E/pause", "OTHER"), { statusCode: 404 });
  assert.equal((await request("GET", "conversations/C/executions", "PROJECT")).status, 200);
  assert.equal((await request("POST", "conversations/C/executions/E/pause", "PROJECT")).status, 202);
  for (const action of ["continue", "restart", "discard"]) assert.equal((await request("POST", `conversations/C/executions/E/${action}`, "PROJECT")).status, 202);
  assert.equal((await request("POST", "conversations/C/executions/E/reconcile", "PROJECT", null, { sequence: 2 })).status, 200);
  assert.deepEqual(calls, [["list", "C", "architect"], ["pause", "C", "E", "architect"], ...["continue", "restart", "discard"].map((action) => ["decide", "C", "E", "architect", action]), ["reconcile", "C", "E", "architect", 2, "unauthenticated-architecture-control"]]);
});
