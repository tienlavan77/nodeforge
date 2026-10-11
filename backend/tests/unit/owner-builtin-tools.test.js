// Verifies direct engineering mode selection, SDK activity and project scope without calling live models.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ownerToolMode, ownerBuiltinOptions, assertBuiltinFilePath } from "../../src/application/owner-builtin-tools.js";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";
import { createOwnerExecutionCheckpoint, executionDigest } from "../../src/application/owner-execution-checkpoint.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

test("tool mode defaults to Forge, pins Continue, and rejects unsupported native providers", () => {
  const profile = { role: "system_engineer", provider: "codex", tool_mode: "builtin" };
  assert.equal(ownerToolMode({ ...profile, tool_mode: undefined }, null, false), "forge");
  assert.equal(ownerToolMode({ ...profile, tool_mode: "forge" }, { tool_mode: "builtin" }, true), "builtin");
  assert.equal(ownerToolMode(profile, {}, true), "forge");
  assert.throws(() => ownerToolMode({ ...profile, provider: "ollama" }, null, false));
  assert.throws(() => ownerToolMode({ ...profile, role: "coder" }, null, false));
});

test("native file hooks deny traversal and symlink escapes and require sandboxed synchronous Bash", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-native-"));
  try {
    await mkdir(join(root, "src"));
    await symlink(tmpdir(), join(root, "escape"));
    await assertBuiltinFilePath(root, "src/new.js");
    await assert.rejects(assertBuiltinFilePath(root, "../outside"));
    await assert.rejects(assertBuiltinFilePath(root, "escape/outside"));
    const options = ownerBuiltinOptions({ provider: "claude" }, root);
    assert.equal(options.sandbox.failIfUnavailable, true);
    assert.equal(options.sandbox.allowUnsandboxedCommands, false);
    assert.equal(options.sandbox.filesystem.denyRead.includes("/"), false);
    assert.equal(options.sandbox.filesystem.denyRead.includes("/lib"), false);
    assert.equal(options.sandbox.filesystem.denyRead.includes("/usr"), false);
    assert.equal(options.sandbox.filesystem.denyRead.includes("/etc"), true);
    assert.equal(options.sandbox.filesystem.denyRead.includes("/home"), true);
    assert.ok(options.sandbox.filesystem.allowRead.includes(root));
    assert.deepEqual(options.mcpServers, {});
    const hook = options.hooks.PreToolUse[0].hooks[0];
    for (const input of [{ tool_name: "Read", tool_input: { file_path: "/etc/passwd" } }, { tool_name: "Bash", tool_input: { dangerouslyDisableSandbox: true } }, { tool_name: "Bash", tool_input: { run_in_background: true } }, { tool_name: "mcp__forge__edit_diff" }]) {
      assert.equal((await hook(input)).hookSpecificOutput.permissionDecision, "deny");
    }
    assert.equal((await hook({ tool_name: "Write", tool_input: { file_path: join(root, "src/new.js") } })).hookSpecificOutput.permissionDecision, "allow");
    const codex = ownerBuiltinOptions({ provider: "codex" }, root);
    assert.equal(codex.usePermissionProfile, true);
    assert.equal(codex.sandboxMode, undefined);
    assert.match(codex.configOverrides[0], /":root"="deny"/);
    assert.match(codex.configOverrides[0], /":minimal"="read"/);
    assert.match(codex.configOverrides[0], /"\/etc"="deny"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex native execution omits Forge, streams activity and saves session mode", async () => {
  let request;
  let state = {};
  const activities = [];
  const logs = [];
  const stream = createOwnerSdkStream({
    agentConfiguration: { getById: () => ({ agent_id: "SE", role: "system_engineer", provider: "codex", tool_mode: "builtin" }) },
    sdkGateways: { codex: { conversationMode: "thread", execute: async (input) => {
      request = input;
      await input.onEvent({ type: "item.started", item: { type: "command_execution", command: "rg GitIndicator ui" } });
      await input.onEvent({ type: "item.completed", item: { type: "command_execution", command: "rg GitIndicator ui", exit_code: 0 } });
      await input.onEvent({ type: "item.completed", item: { id: "text", type: "agent_message", text: "Done" } });
      return { text: "Done", thread_id: "THREAD" };
    } } },
    conversationStateStore: { create: async () => state, update: async (id, value) => { state = { ...state, ...value }; } },
    fallbackStream: async function* () {}, projectRoot: process.cwd(), projectLogger: (value) => logs.push(value)
  });
  const chunks = [];
  for await (const chunk of stream({ agentId: "SE", payload: { text: "Implement UI" }, correlationId: "C", conversationId: "CONV", eventSink: (value) => activities.push(value) })) chunks.push(chunk);
  assert.equal(request.options.forgeTools, undefined);
  assert.equal(request.options.usePermissionProfile, true);
  assert.deepEqual(chunks, [{ text: "Done" }]);
  assert.equal(state.sdk_tool_mode, "builtin");
  assert.equal(state.sdk_thread_id, "THREAD");
  assert.deepEqual(activities.map((value) => value.payload.activity_type), ["tool_started", "tool_completed"]);
  assert.ok(logs.some((value) => value.event_name === "owner.tool_call" && value.payload.tool === "command_execution"));
});

test("Claude gateway preserves native guards and emits command and text streaming events", async () => {
  let options;
  const events = [];
  const deltas = [];
  const profile = { agent_id: "SE", role: "system_engineer", provider: "claude", enabled: true, status: "ready", credential_ref: "ref", gateway_url: "https://gateway.test" };
  const native = ownerBuiltinOptions(profile, process.cwd());
  const gateway = createClaudeSdkGateway({ configuration: { getById: () => profile }, credentialResolver: async () => "credential", terminalOutput: { write() {} },
    queryFn: ({ options: value }) => { options = value; return (async function* () {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "git status" } }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "clean" }] } };
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Done" } } };
    })(); } });
  await gateway.execute({ agentId: "SE", prompt: "Inspect", correlationId: "C", options: { ...native, onBuiltinToolEvent: (event) => events.push(event), onTextDelta: (text) => deltas.push(text) } });
  assert.equal(typeof options.hooks.PreToolUse[0].hooks[0], "function");
  assert.deepEqual(options.mcpServers, undefined);
  assert.deepEqual(events.map(({ tool, status }) => [tool, status]), [["Bash", "started"], ["Bash", "success"]]);
  assert.deepEqual(deltas, ["Done"]);
});

test("native Continue keeps its SDK session and mode after the profile switches to Forge", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-native-resume-"));
  try {
    const files = createFileService({ projectRoot: root });
    const checkpoint = createOwnerExecutionCheckpoint({ fileService: files });
    await checkpoint.start({ conversationId: "C", executionId: "E", provider: "codex", promptHash: executionDigest("Fix") });
    await checkpoint.patch("C", "E", { tool_mode: "builtin", checkpoint_kind: "sdk_session", provider_thread_id: "THREAD", status: "interrupted" });
    await checkpoint.markStopped("C", "E");
    let request;
    const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ agent_id: "SE", role: "system_engineer", provider: "codex", tool_mode: "forge" }) },
      sdkGateways: { codex: { conversationMode: "thread", execute: async (input) => { request = input; input.onSessionReady("THREAD"); return { text: "Continued" }; } } },
      executionCheckpoint: checkpoint, projectRoot: root, fallbackStream: async function* () {} });
    for await (const chunk of stream({ agentId: "SE", payload: { text: "Fix", continue_execution: true }, correlationId: "E", conversationId: "C" })) assert.equal(chunk.text, "Continued");
    assert.equal(request.resumeThreadId, "THREAD");
    assert.equal(request.options.forgeTools, undefined);
    const record = await checkpoint.load("C", "E");
    assert.equal(record.tool_mode, "builtin");
    assert.equal(record.checkpoint_kind, "sdk_session");
    assert.deepEqual(record.completed_tool_calls, []);
    assert.equal(record.status, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude and Anthropic native streams omit Forge and publish partial text and activity", async () => {
  for (const provider of ["claude", "anthropic"]) {
    let request;
    const activity = [];
    const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ agent_id: "SE", role: "system_engineer", provider, tool_mode: "builtin" }) },
      sdkGateways: { [provider]: { conversationMode: "history", execute: async (input) => {
        request = input;
        input.options.onTextDelta("Done");
        input.options.onBuiltinToolEvent({ tool: "Edit", status: "success", path: "src/main.js" });
        return { text: "Done" };
      } } }, projectRoot: process.cwd(), fallbackStream: async function* () {} });
    const chunks = [];
    for await (const chunk of stream({ agentId: "SE", payload: { text: "Fix" }, correlationId: "E", conversationId: "C", eventSink: (event) => activity.push(event) })) chunks.push(chunk);
    assert.equal(request.options.forgeTools, undefined);
    assert.deepEqual(request.options.mcpServers, {});
    assert.ok(request.options.tools.includes("Bash"));
    assert.deepEqual(chunks, [{ text: "Done" }]);
    assert.equal(activity[0].payload.tool_name, "Edit");
  }
});

test("native Stop aborts the SDK runner without requiring Forge receipts", async () => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ agent_id: "SE", role: "system_engineer", provider: "codex", tool_mode: "builtin" }) },
    sdkGateways: { codex: { conversationMode: "thread", execute: async ({ abortSignal }) => new Promise((resolve, reject) => {
      abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
      started();
    }) } }, projectRoot: process.cwd(), fallbackStream: async function* () {} });
  const running = (async () => { for await (const chunk of stream({ agentId: "SE", payload: { text: "Fix" }, correlationId: "E", conversationId: "C" })) assert.fail(chunk); })();
  await ready;
  assert.equal(stream.pause("C"), true);
  await assert.rejects(running, { code: "EXECUTION_PAUSED" });
  assert.equal(stream.isActive("C"), false);
});
