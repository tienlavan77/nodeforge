// Verifies owner chat selects the profile SDK and streams Forge tool results without duplicate text.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

// Confirms Codex SDK receives Forge MCP tools and resumes the stored conversation thread.
test("Architecture Manager streams SDK deltas and persists its thread", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-owner-sdk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  await mkdir(join(root, "empty"));
  const state = { sdk_provider: "codex", sdk_thread_id: "thread-old" };
  let request;
  const gateway = { conversationMode: "thread", async execute(input) {
    request = input;
    const tree = await input.options.forgeTools.registry.search_tree.execute({ flags: ["--dirs-only"] });
    assert.equal(tree.tree, ".\n└── empty/");
    input.onSessionReady("thread-new");
    await input.onEvent({ type: "item.updated", item: { id: "answer", type: "agent_message", text: "Hello" } });
    await input.onEvent({ type: "item.completed", item: { id: "answer", type: "agent_message", text: "Hello world" } });
    return { text: "Hello world", usage: { input_tokens: 1, output_tokens: 2 } };
  } };
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ role: "architecture_manager", provider: "codex" }) },
    sdkGateways: { codex: gateway }, fallbackStream: async function* () { yield { text: "unexpected fallback" }; },
    conversationStateStore: { create: async () => state, update: async (_, value) => Object.assign(state, value) }, fileService: createFileService({ projectRoot: root }), projectRoot: root, projectLogger: () => {} });
  const chunks = [];
  for await (const chunk of stream({ agentId: "AM", payload: { text: "Tree" }, correlationId: "CORR-SDK", conversationId: "CONV-SDK" })) chunks.push(chunk);
  assert.equal(chunks.map((chunk) => chunk.text ?? "").join(""), "Hello world");
  assert.equal(request.resumeThreadId, "thread-old");
  assert.equal(request.options.sandboxMode, "read-only");
  assert.match(request.prompt, /Never use built-in command_execution/);
  assert.deepEqual(request.options.forgeTools.definitions.map((item) => item.name), ["rg_files", "search_tree", "read_file", "sed_lines"]);
  assert.equal(state.sdk_thread_id, "thread-new");
});

// Confirms Claude Architecture Manager conversations use the Claude SDK adapter.
test("Architecture Manager streams Claude SDK conversation replies", async () => {
  let request;
  const gateway = { conversationMode: "history", async execute(input) {
    request = input;
    return { text: "Hello from Claude" };
  } };
  const stream = createOwnerSdkStream({
    agentConfiguration: { getById: () => ({ role: "architecture_manager", provider: "claude" }) },
    sdkGateways: { claude: gateway },
    fallbackStream: async function* () { yield { text: "unexpected fallback" }; },
    conversationStateStore: { create: async () => ({}), update: async () => {} },
    fileService: createFileService({ projectRoot: process.cwd() }),
    projectRoot: process.cwd(),
    projectLogger: () => {}
  });
  const chunks = [];
  for await (const chunk of stream({ agentId: "AM", payload: { text: "Xin chào" }, correlationId: "CORR-CLAUDE", conversationId: "CONV-CLAUDE" })) chunks.push(chunk);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ["Hello from Claude"]);
  assert.equal(request.agentId, "AM");
  assert.equal(request.agent.provider, "claude");
  assert.match(request.prompt, /Xin chào/);
});

test("profile provider selects its SDK and other roles keep their stream", async () => {
  const profile = { role: "architecture_manager", provider: "openai" };
  let invoked = 0;
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => profile }, sdkGateways: { openai: { conversationMode: "history", async execute() { invoked++; return { text: "OpenAI reply" }; } } },
    fallbackStream: async function* () { yield { text: "fallback" }; }, conversationStateStore: { create: async () => ({}) }, fileService: createFileService({ projectRoot: process.cwd() }), projectRoot: process.cwd(), projectLogger: () => {} });
  const first = [];
  for await (const chunk of stream({ agentId: "AM", payload: { text: "Hello" }, correlationId: "CORR-OAI", conversationId: "CONV-OAI" })) first.push(chunk.text);
  assert.deepEqual(first, ["OpenAI reply"]);
  profile.role = "reviewer";
  const second = [];
  for await (const chunk of stream({ agentId: "RV", payload: { text: "Review" }, correlationId: "CORR-RV", conversationId: "CONV-RV" })) second.push(chunk.text);
  assert.deepEqual(second, ["fallback"]);
  assert.equal(invoked, 1);
});

// Confirms Codex built-in command events abort an owner chat turn.
test("Codex built-in command is rejected by owner SDK stream", async () => {
  const events = [];
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ role: "architecture_manager", provider: "codex" }) },
    sdkGateways: { codex: { conversationMode: "thread", async execute(input) { await input.onEvent({ type: "item.started", item: { type: "command_execution" } }); } } },
    fallbackStream: async function* () { yield { text: "fallback" }; }, conversationStateStore: { create: async () => ({}) },
    fileService: createFileService({ projectRoot: process.cwd() }), projectRoot: process.cwd(), projectLogger: (event) => events.push(event) });
  await assert.rejects(async () => {
    for await (const chunk of stream({ agentId: "AM", payload: { text: "Run command" }, correlationId: "CORR-DENY", conversationId: "CONV-DENY" })) assert.ok(chunk);
  }, /unapproved built-in tool/);
  assert.ok(events.some((event) => event.event_name === "owner.sdk_failed"));
});

// Confirms provider changes preserve conversation context without reusing provider thread IDs.
test("profile provider switch keeps conversation history", async () => {
  const state = { sdk_provider: "prior-provider", sdk_thread_id: "prior-thread", sdk_history: [{ role: "User", text: "Old" }] };
  const requests = [];
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ role: "architecture_manager", provider: "new-provider" }) },
    sdkGateways: { "new-provider": { conversationMode: "history", async execute(input) { requests.push(input); return { text: `Reply ${requests.length}` }; } } },
    fallbackStream: async function* () {}, conversationStateStore: { create: async () => ({ ...state }), update: async (_, value) => Object.assign(state, value) },
    fileService: createFileService({ projectRoot: process.cwd() }), projectRoot: process.cwd(), projectLogger: () => {} });
  for (let index = 0; index < 2; index++) {
    for await (const chunk of stream({ agentId: "AM", payload: { text: `Question ${index + 1}` }, correlationId: `CORR-${index}`, conversationId: "CONV-SWITCH" })) assert.ok(chunk.text);
  }
  assert.match(requests[0].prompt, /Old/);
  assert.match(requests[1].prompt, /Reply 1/);
  assert.equal(state.sdk_provider, "new-provider");
  assert.equal(state.sdk_thread_id, null);
});

// Confirms a new SDK receives prior UI messages when the previous provider stored only its thread.
test("provider switch loads persisted conversation messages", async () => {
  const state = { sdk_provider: "former", sdk_thread_id: "former-thread" };
  let request;
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ role: "architecture_manager", provider: "current" }) },
    sdkGateways: { current: { conversationMode: "thread", async execute(input) { request = input; input.onSessionReady("current-thread"); return { text: "New answer" }; } } },
    fallbackStream: async function* () {}, conversationStateStore: { create: async () => ({ ...state }), update: async (_, value) => Object.assign(state, value) },
    conversationMessages: { getByConversationId: () => [
      { correlation_id: "OLD", message_type: "owner.message", payload: { text: "Previous question" } },
      { correlation_id: "OLD", message_type: "architecture.message.received", payload: { text: "Previous answer" } },
      { correlation_id: "NOW", message_type: "owner.message", payload: { text: "Current question" } }
    ] }, fileService: createFileService({ projectRoot: process.cwd() }), projectRoot: process.cwd(), projectLogger: () => {} });
  for await (const chunk of stream({ agentId: "AM", payload: { text: "Current question" }, correlationId: "NOW", conversationId: "SAME-CONVERSATION" })) assert.ok(chunk.text);
  assert.equal(request.resumeThreadId, undefined);
  assert.match(request.prompt, /Previous question[\s\S]*Previous answer[\s\S]*Current question/);
  assert.equal(request.prompt.match(/Current question/g)?.length, 1);
  assert.equal(state.sdk_thread_id, "current-thread");
  assert.equal(state.sdk_history.length, 4);
});
