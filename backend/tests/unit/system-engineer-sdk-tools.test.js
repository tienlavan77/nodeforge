// Summary: Confirms owner conversations expose governed Forge tools through each provider SDK contract.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";
import { createOwnerConversationTools } from "../../src/tools/owner-conversation-tools.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Builds a minimal project file service so Owner tools can be registered without touching disk.
function fileService() { return { readFile() {}, readForIndex() {}, atomicWrite() {}, deleteFile() {}, listDirectories: async () => [], listFiles: async () => [] }; }

// Keeps SDK tool tests focused on persisted conversation state without a filesystem store.
function memoryStateStore() {
  const states = new Map();
  return {
    async create({ conversationId, agentId }) { if (!states.has(conversationId)) states.set(conversationId, { conversation_id: conversationId, agent_id: agentId }); return structuredClone(states.get(conversationId)); },
    async get(conversationId) { return states.has(conversationId) ? structuredClone(states.get(conversationId)) : null; },
    async update(conversationId, changes) { const next = { ...states.get(conversationId), ...structuredClone(changes) }; states.set(conversationId, next); return structuredClone(next); }
  };
}

test("System Engineer exposes the same Forge discovery and engineering tools across all SDK providers", async () => {
  const expected = ["search_tree", "list_files", "search_text", "read_file", "read_lines", "write_diff", "edit_diff", "git_status", "git_diff", "run_check", "commit_changes", "push_commit", "delete_file"];
  for (const provider of ["openai", "codex", "claude", "anthropic", "ollama"]) {
    let request;
    const profile = { agent_id: "engineer", agent_name: "Engineer", role: "system_engineer", provider };
    const sdk = { conversationMode: provider === "codex" ? "thread" : "history", builtinWebSearchAvailable: provider !== "ollama", execute: async (input) => { request = input; return { text: "ready" }; } };
    const gitService = { status: async () => "", diffWorkingTree: async () => "", commit: async () => ({ sha: "a".repeat(40) }), pushCommit: async (sha) => ({ sha }) };
    const testService = { runCheck: async () => ({ status: "passed" }) };
    const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => profile }, sdkGateways: { [provider]: sdk }, fallbackStream: async function* () {}, fileService: fileService(), conversationStateStore: memoryStateStore(), testService, gitService, projectRoot: "/project", projectLogger: () => {} });
    for await (const chunk of stream({ agentId: "engineer", payload: { text: "inspect" }, correlationId: `CORR-${provider}`, conversationId: `CONV-${provider}` })) assert.equal(chunk.text, "ready");
    const names = request.options.forgeTools.definitions.map(({ name }) => name);
    assert.deepEqual(names, expected, provider);
    for (const name of ["search_tree", "list_files", "search_text"]) assert.ok(names.includes(name), `${provider} must expose Forge search tool ${name}`);
    if (["claude", "anthropic"].includes(provider)) {
      assert.equal(request.options.allowedTools.includes("WebSearch"), false);
      assert.deepEqual(request.options.tools, []);
    }
    assert.equal(request.options.builtinWebSearch, false, provider);
    assert.equal(request.options.builtinSearchShell, undefined, `${provider} must use Forge search tools`);
  }
});

test("System Engineer translates the request to English and is instructed to search with Forge search_text", async () => {
  let request;
  const profile = { agent_id: "engineer", agent_name: "Engineer", role: "system_engineer", provider: "codex" };
  const sdk = { conversationMode: "thread", execute: async (input) => { request = input; return { text: "done", thread_id: "thread-1" }; } };
  const gitService = { status: async () => "", diffWorkingTree: async () => "", commit: async () => ({ sha: "a".repeat(40) }), pushCommit: async (sha) => ({ sha }) };
  const testService = { runCheck: async () => ({ status: "passed" }) };
  const conversationStateStore = memoryStateStore();
  const logs = [];
  const activities = [];
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => profile }, sdkGateways: { codex: sdk }, fallbackStream: async function* () {}, fileService: fileService(), conversationStateStore, testService, gitService, projectRoot: "/project", projectLogger: (event) => logs.push(event) });
  for await (const chunk of stream({ agentId: "engineer", payload: { text: "inspect and fix the project" }, correlationId: "CORR-SYSTEM-ENGINEER", conversationId: "CONV-SYSTEM-ENGINEER", eventSink: (event) => activities.push(event) })) assert.equal(typeof chunk.text, "string");
  assert.deepEqual(request.options.forgeTools.definitions.map(({ name }) => name), ["search_tree", "list_files", "search_text", "read_file", "read_lines", "write_diff", "edit_diff", "git_status", "git_diff", "run_check", "commit_changes", "push_commit", "delete_file"]);
  assert.equal(request.options.sandboxMode, "read-only");
  assert.equal(request.options.networkAccessEnabled, false);
  assert.equal(request.options.webSearchMode, "disabled");
  assert.deepEqual(request.options.config, { default_permissions: "audit" });
  assert.match(request.options.configOverrides[0], /permissions\.audit\.filesystem/);
  assert.match(request.options.configOverrides[0], /"\/project"="read"/);
  assert.match(request.prompt, /not a ticket/);
  assert.match(request.prompt, /translate the owner's request into concise English code\/business terms/);
  assert.match(request.prompt, /Use the Forge search_text tool first with those English terms/);
  assert.deepEqual(logs.map(({ event_name }) => event_name), ["owner.sdk_route", "owner.sdk_request_started", "owner.sdk_request_completed"]);
  await request.onEvent({ type: "item.started", item: { id: "CALL-1", type: "mcp_tool_call", server: "forge", tool: "search_text" } });
  await request.onEvent({ type: "item.completed", item: { id: "CALL-1", type: "mcp_tool_call", server: "forge", tool: "search_text", status: "completed" } });
  assert.deepEqual(activities.map(({ payload }) => [payload.activity_type, payload.status, payload.tool_name]), [["tool_started", "working", "search_text"], ["tool_completed", "success", "search_text"]]);
  assert.ok(activities.every(({ event_type, conversation_id }) => event_type === "agent.activity" && conversation_id === "CONV-SYSTEM-ENGINEER"));
  await assert.rejects(() => request.onEvent({ type: "item.started", item: { type: "command_execution", command: "git status" } }), { code: "TOOL_FORBIDDEN" });
  await assert.rejects(() => request.onEvent({ type: "item.started", item: { type: "command_execution", command: "rg --files backend/src" } }), { code: "TOOL_FORBIDDEN" });
  await assert.rejects(() => request.onEvent({ type: "item.started", item: { type: "command_execution", command: "rg --pre cat secret" } }), { code: "TOOL_FORBIDDEN" });
  await assert.rejects(() => request.onEvent({ type: "item.started", item: { type: "command_execution", command: "rg --file=/etc/passwd secret" } }), { code: "TOOL_FORBIDDEN" });
  await assert.rejects(() => request.onEvent({ type: "item.started", item: { type: "file_change" } }), { code: "TOOL_FORBIDDEN" });
  await assert.rejects(() => request.onEvent({ type: "item.started", item: { type: "web_search" } }), { code: "TOOL_FORBIDDEN" });
  await assert.rejects(() => request.onEvent({ type: "item.started", item: { type: "local_shell_call" } }), { code: "TOOL_FORBIDDEN" });
  await assert.rejects(() => request.onEvent({ type: "item.started", item: { type: "mcp_tool_call", server: "filesystem", tool: "read_file" } }), { code: "TOOL_FORBIDDEN" });
  await assert.rejects(() => request.onEvent({ type: "item.started", item: { type: "mcp_tool_call", server: "forge", tool: "Bash" } }), { code: "TOOL_FORBIDDEN" });
});

test("System Engineer Forge mode disables all native tools", async () => {
  let request;
  const profile = { agent_id: "engineer", agent_name: "Engineer", role: "system_engineer", provider: "anthropic" };
  const sdk = { conversationMode: "history", execute: async (input) => { request = input; return { text: "done" }; } };
  const gitService = { status: async () => "", diffWorkingTree: async () => "", commit: async () => ({ sha: "a".repeat(40) }), pushCommit: async (sha) => ({ sha }) };
  const testService = { runCheck: async () => ({ status: "passed" }) };
  const conversationStateStore = memoryStateStore();
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => profile }, sdkGateways: { anthropic: sdk }, fallbackStream: async function* () {}, fileService: fileService(), conversationStateStore, testService, gitService, projectRoot: "/project", projectLogger: () => {} });
  for await (const chunk of stream({ agentId: "engineer", payload: { text: "inspect" }, correlationId: "CORR-ENGINEER-CLAUDE", conversationId: "CONV-ENGINEER-CLAUDE" })) assert.equal(typeof chunk.text, "string");
  assert.deepEqual(request.options.tools, []);
  assert.ok(request.options.allowedTools.includes("mcp__forge__search_text"));
  assert.ok(request.options.allowedTools.includes("mcp__forge__list_files"));
  assert.ok(request.options.allowedTools.includes("mcp__forge__edit_diff"));
  assert.ok(request.options.allowedTools.includes("mcp__forge__run_check"));
  assert.equal(request.options.sandbox, undefined);
  assert.equal(request.options.canUseTool, undefined);
});

test("Claude gateway preserves Forge-only tools for System Engineer", async () => {
  let sdkOptions;
  const events = [];
  const profile = { agent_id: "engineer", agent_name: "Engineer", role: "system_engineer", provider: "anthropic", model: "claude-test", gateway_url: "https://example.test/v1", credential_ref: "test", enabled: true, status: "ready" };
  const gateway = createClaudeSdkGateway({ configuration: { getById: () => profile }, credentialResolver: async () => "secret", queryFn: ({ options }) => {
    sdkOptions = options;
    return (async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "Found the source." }] } };
    })();
  } });
  const logger = (event) => events.push(event);
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => profile }, sdkGateways: { anthropic: gateway }, fallbackStream: async function* () {}, fileService: fileService(), testService: { runCheck: async () => ({ status: "passed" }) }, gitService: { status: async () => "", diffWorkingTree: async () => "" }, projectRoot: "/project", projectLogger: logger });
  const chunks = [];
  for await (const chunk of stream({ agentId: "engineer", payload: { text: "find a source file" }, correlationId: "CORR-CLAUDE-SEARCH", conversationId: "CONV-CLAUDE-SEARCH" })) chunks.push(chunk.text);
  assert.deepEqual(sdkOptions.tools, []);
  assert.equal(sdkOptions.allowedTools.includes("WebSearch"), false);
  assert.ok(sdkOptions.allowedTools.includes("mcp__forge__search_text"));
  assert.deepEqual(chunks, ["Found the source."]);
  assert.equal(events.some((event) => event.event_name === "owner.builtin_search"), false);
});

test("System Engineer Forge read_lines reads project files without a ticket manifest", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "nodeforge-system-engineer-"));
  try {
    const files = createFileService({ projectRoot });
    await files.atomicWrite({ path: "src/example.js", content: "export const answer = 42;\n", replace: true });
    const context = { task_id: "CORR-ENGINEER-SED", agent_identity: { agent_id: "engineer", role: "system_engineer" }, project_wide_access: true };
    const { definitions, registry } = createOwnerConversationTools({ role: "system_engineer", projectRoot, fileService: files, gitService: { status: async () => "", diffWorkingTree: async () => "" }, context, projectLogger: () => {} });
    context.capabilities = definitions.map(({ name }) => name);
    const result = await registry.read_lines.execute({ path: "src/example.js", start_line: 1, end_line: 1 }, context);
    assert.equal(result.stdout, "export const answer = 42;\n");
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});

test("Anthropic owner Forge calls announce start and completion in the API terminal", async () => {
  const lines = [];
  const events = [];
  const logger = createRuntimeLogger({ logEvent: (event) => events.push(event), output: { write: (line) => lines.push(line) } });
  let request;
  const profile = { agent_id: "architect", agent_name: "Architect", role: "architecture_manager", provider: "anthropic" };
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => profile }, sdkGateways: { anthropic: { conversationMode: "history", execute: async (input) => { request = input; return { text: "ok" }; } } }, fallbackStream: async function* () {}, fileService: fileService(), projectRoot: process.cwd(), projectLogger: logger.emit });
  for await (const chunk of stream({ agentId: "architect", payload: { text: "list project" }, correlationId: "CORR-ANTHROPIC-TOOLS", conversationId: "CONV-ANTHROPIC-TOOLS" })) assert.equal(chunk.text, "ok");
  await request.options.forgeTools.registry.search_tree.execute({ path: ".", max_depth: 1 }, request.options.forgeTools.context);
  assert.deepEqual(events.filter((event) => event.event_name === "owner.tool_call").map((event) => event.status), ["started", "success"]);
  assert.ok(lines.some((line) => line.includes("[Architect] (anthropic) search_tree START")));
  assert.ok(lines.some((line) => line.includes("[Architect] (anthropic) search_tree PASS")));
});

