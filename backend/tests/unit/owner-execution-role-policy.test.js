// Verifies shared owner recovery policy preserves separate roots, immutable identities, and fail-closed role boundaries.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createOwnerExecutionCheckpoint, executionDigest } from "../../src/application/owner-execution-checkpoint.js";
import { ownerExecutionRolePolicy } from "../../src/application/owner-execution-role-policy.js";
import { createOwnerExecutionControl } from "../../src/application/owner-execution-control.js";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";

const roles = ["system_engineer", "architecture_manager"];

// Creates durable test stores that share implementation but never a runtime root or lease.
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "nf-owner-role-policy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const files = createFileService({ projectRoot: root });
  const stores = Object.fromEntries(roles.map((role) => [role, createOwnerExecutionCheckpoint({ fileService: files, role })]));
  return { root, files, stores };
}

// Locates existing-format records to simulate corruption without changing production record naming.
function recordPath(role, conversationId, executionId) {
  return `${ownerExecutionRolePolicy(role).root}/${executionDigest(conversationId).slice(0, 32)}-${executionDigest(executionId).slice(0, 32)}.json`;
}

// Starts a role-scoped turn with the same identities used to exercise cross-role isolation.
function start(store, conversationId = "conversation", executionId = "execution", extra = {}) {
  return store.start({ conversationId, executionId, messageId: "message", provider: "codex", promptHash: executionDigest("inspect"), ...extra });
}

// Rejects missing or unsupported roles instead of silently selecting System Engineer privileges.
test("checkpoint roles are explicit and root selection cannot be overridden", async (context) => {
  const { files } = await fixture(context);
  for (const role of [undefined, "coder", "reviewer", "unknown_role", "toString", "__proto__"]) {
    assert.throws(() => createOwnerExecutionCheckpoint({ fileService: files, role }), /explicit supported role/);
  }
  const architecture = createOwnerExecutionCheckpoint({ fileService: files, role: "architecture_manager", root: ownerExecutionRolePolicy("system_engineer").root });
  await start(architecture);
  assert.equal((await files.listFiles({ glob: `${ownerExecutionRolePolicy("system_engineer").root}/*.json` })).length, 0);
  assert.equal((await files.listFiles({ glob: `${ownerExecutionRolePolicy("architecture_manager").root}/*.json` })).length, 1);
  assert.equal(Object.isFrozen(ownerExecutionRolePolicy("architecture_manager")), true);
});

// Keeps two roles independent even when conversation and execution identifiers are identical.
test("separate roots preserve role-local leases and role-specific busy messages", async (context) => {
  const { stores } = await fixture(context);
  const [engineer, architecture] = await Promise.all(roles.map((role) => start(stores[role])));
  assert.equal(engineer.role, "system_engineer");
  assert.equal(architecture.role, "architecture_manager");
  for (const role of roles) {
    assert.equal((await stores[role].list("conversation")).length, 1);
    assert.equal((await stores[role].load("conversation", "execution")).role, role);
    await assert.rejects(start(stores[role], "conversation", "other"), { code: "EXECUTION_BUSY", message: `A ${ownerExecutionRolePolicy(role).displayName} execution is already running in this conversation.` });
  }
});

for (const role of roles) {
  // Rejects all identity overwrite attempts without changing durable audit or lease evidence.
  test(`${role}: patch cannot change role, conversation, execution, or lineage identity`, async (context) => {
    const { stores } = await fixture(context);
    const store = stores[role];
    const original = await start(store);
    const fields = { role: roles.find((candidate) => candidate !== role), conversation_id: "other", execution_id: "other", lineage_id: "other", attempt_number: 99, resume_of: "other" };
    for (const [field, value] of Object.entries(fields)) {
      await assert.rejects(store.patch("conversation", "execution", { [field]: value }), { code: "EXECUTION_IDENTITY_IMMUTABLE" });
      assert.deepEqual(await store.load("conversation", "execution"), original);
    }
    assert.equal((await store.patch("conversation", "execution", { provider_thread_id: "thread" })).provider_thread_id, "thread");
  });

  for (const recordRole of [undefined, roles.find((candidate) => candidate !== role)]) {
    // Blocks misplaced records before listing, resuming, restarting, closing, or starting replacement work.
    test(`${role}: missing or foreign role is fail-closed (${recordRole ?? "missing"})`, async (context) => {
      const { files, stores } = await fixture(context);
      const store = stores[role];
      const record = await start(store);
      const corrupted = { ...record, role: recordRole, status: "interrupted", runner_stopped_at: new Date().toISOString() };
      const content = `${JSON.stringify(corrupted)}\n`;
      const path = recordPath(role, "conversation", "execution");
      await files.atomicWrite({ path, content, replace: true });
      const logged = context.mock.method(console, "error", () => {});
      const blocked = { code: "EXECUTION_RECONCILIATION_REQUIRED", statusCode: 404, recovery_status: "manual_required" };
      await assert.rejects(store.load("conversation", "execution"), blocked);
      await assert.rejects(store.list("conversation"), blocked);
      await assert.rejects(start(store, "conversation", "new", { resumeOf: "execution" }), blocked);
      await assert.rejects(start(store, "conversation", "execution", { continueAttempt: true }), blocked);
      await assert.rejects(store.close("conversation", "execution", "discarded"), blocked);
      await assert.rejects(start(store, "conversation", "new"), blocked);
      assert.equal(await store.reconcile(corrupted), false);
      assert.equal(await files.readFile({ path }), content);
      assert.ok(logged.mock.calls.length >= 6);
    });
  }
}

// Prevents cross-role restart from inheriting or closing the other role's valid lineage.
test("restart cannot seed lineage from the other root", async (context) => {
  const { stores } = await fixture(context);
  const architecture = stores.architecture_manager;
  const engineer = stores.system_engineer;
  await start(architecture);
  await architecture.patch("conversation", "execution", { status: "interrupted" });
  await architecture.markStopped("conversation", "execution");
  const parent = await architecture.load("conversation", "execution");
  await assert.rejects(start(engineer, "conversation", "child", { resumeOf: "execution" }), { code: "EXECUTION_RECONCILIATION_REQUIRED" });
  assert.equal(await engineer.load("conversation", "child"), null);
  assert.deepEqual(await architecture.load("conversation", "execution"), parent);
});

// Preserves Architecture's mutation restrictions and prevents System Engineer run-check settlement from leaking across roles.
test("Architecture policy denies SE mutations and never settles legacy run_check boundaries", async (context) => {
  const { files, stores } = await fixture(context);
  const architecture = stores.architecture_manager;
  await start(architecture);
  for (const name of ["run_check", "commit_changes", "push_commit"]) {
    await assert.rejects(architecture.beforeTool("conversation", "execution", name, {}), { code: "TOOL_FORBIDDEN" });
  }
  const record = await architecture.load("conversation", "execution");
  const pending = { sequence: 1, tool_name: "run_check", mutating: true };
  const legacy = { ...record, next_sequence: 3, pending_tool_calls: [pending], completed_tool_calls: [{ sequence: 2, tool_name: "read_file" }] };
  await files.atomicWrite({ path: recordPath("architecture_manager", "conversation", "execution"), content: `${JSON.stringify(legacy)}\n`, replace: true });
  const [inspected] = await architecture.inspect("conversation");
  assert.deepEqual(inspected.pending_tool_calls, [pending]);
  assert.equal(inspected.settled_tool_calls, undefined);
  await assert.rejects(architecture.beforeTool("conversation", "execution", "read_file", {}), { code: "EXECUTION_BUSY" });
});

// Keeps execution controls scoped to the message recipient and exposes role-aware recovery labels.
test("control summaries show role and refuse cross-role or missing-role recovery", async (context) => {
  const { stores } = await fixture(context);
  await start(stores.architecture_manager);
  await stores.architecture_manager.patch("conversation", "execution", { status: "interrupted" });
  await stores.architecture_manager.markStopped("conversation", "execution");
  const communications = { getById: () => ({ conversation_id: "conversation", recipient: { id: "architect" } }) };
  const agentConfiguration = { getById: (id) => ({ role: id === "architect" ? "architecture_manager" : id === "engineer" ? "system_engineer" : "coder" }) };
  const control = createOwnerExecutionControl({ checkpoint: stores.system_engineer, architectureCheckpoint: stores.architecture_manager, communications, agentConfiguration });
  const [visible] = await control.list("conversation", "architect");
  assert.equal(visible.role, "architecture_manager");
  assert.equal(visible.display_name, "Architecture Manager");
  assert.equal(control.requiresOwnerAuth("architect"), true);
  assert.equal(control.requiresOwnerAuth("engineer"), false);
  assert.equal(control.requiresOwnerAuth("coder"), false);
  for (const decision of ["continue", "restart", "discard"]) {
    await assert.rejects(control.decide("conversation", "execution", "engineer", decision), { statusCode: 404 });
  }
  await assert.rejects(control.reconcilePending("conversation", "execution", "engineer", 1, "owner"), { statusCode: 404 });
  await assert.rejects(control.list("conversation", "coder"), { statusCode: 404 });
  const incomplete = createOwnerExecutionControl({ architectureCheckpoint: { role: "architecture_manager", load: async () => ({ message_id: "message" }) }, communications, agentConfiguration });
  await assert.rejects(incomplete.pause("conversation", "execution", "architect"), { statusCode: 404 });
});

// Rejects incorrectly wired stores before an SDK turn can create a record under the wrong role.
test("SDK verifies profile and store role before creating a checkpoint", async (context) => {
  const { stores } = await fixture(context);
  let executeCalls = 0;
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ role: "architecture_manager", provider: "codex" }) }, architectureCheckpoint: stores.system_engineer,
    sdkGateways: { codex: { conversationMode: "thread", execute: async () => { executeCalls += 1; return {}; } } }, fallbackStream: async function* () {} });
  await assert.rejects(async () => { for await (const chunk of stream({ agentId: "architect", payload: { text: "inspect" }, correlationId: "execution", conversationId: "conversation" })) assert.fail(chunk); }, /role does not match/);
  assert.equal(executeCalls, 0);
  assert.deepEqual(await stores.system_engineer.list("conversation"), []);
  assert.equal(stream.isActive("conversation"), false);
});

// Keeps shared recovery implementation and its focused regression tests within the project's retrieval-friendly size limit.
test("P1 source and test files remain at most 250 lines", async () => {
  const paths = ["../../src/application/owner-execution-role-policy.js", "../../src/application/owner-execution-record-guards.js", "../../src/application/owner-execution-checkpoint.js", "../../src/application/owner-execution-control.js", "../../src/application/owner-sdk-stream.js", "../../scripts/control-api-http.mjs", "./owner-execution-role-policy.test.js", "./owner-execution-checkpoint.test.js", "./architecture-execution.test.js", "./owner-builtin-tools.test.js"];
  for (const path of paths) {
    const content = await readFile(new URL(path, import.meta.url), "utf8");
    assert.ok(content.trimEnd().split("\n").length <= 250, `${path} exceeds 250 lines`);
  }
});
