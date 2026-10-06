// Summary: Confirms owner conversations expose governed Forge tools through each provider SDK contract.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";
import { createOpenAiSdkGateway } from "../../src/modules/agent/openai-sdk-gateway.js";
import { createOwnerSearchTreeTool } from "../../src/tools/owner-search-tree.js";
import { RunContext } from "@openai/agents";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";
import { authorizeOwnerTool, ownerWritePrefixes } from "../../src/tools/owner-role-tool-policy.js";
import { createOwnerDeleteFileTool } from "../../src/tools/owner-delete-file.js";
import { createReadFileTool } from "../../src/tools/agent-lifecycle-tools.js";
import { createOwnerConversationTools } from "../../src/tools/owner-conversation-tools.js";
import { createOwnerBuiltinSearchShell } from "../../src/tools/owner-builtin-search-shell.js";
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

test("owner exposes the same approved Forge tools to OpenAI, Codex, Claude, and Anthropic", async () => {
  for (const provider of ["openai", "codex", "claude", "anthropic"]) {
    let request;
    const profile = { agent_id: "architect", role: "architecture_manager", provider };
    const sdk = { conversationMode: provider === "codex" ? "thread" : "history", execute: async (input) => { request = input; return { text: "ok" }; } };
    const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => profile }, sdkGateways: { [provider]: sdk }, fallbackStream: async function* () {}, fileService: fileService(), projectRoot: process.cwd(), projectLogger: () => {} });
    for await (const chunk of stream({ agentId: "architect", payload: { text: "inspect project" }, correlationId: `CORR-${provider}`, conversationId: `CONV-${provider}` })) assert.equal(typeof chunk.text, "string");
    assert.deepEqual(request.options.forgeTools.definitions.map(({ name }) => name), ["search_tree", "list_files", "search_text", "read_file", "read_lines", "write_diff", "edit_diff", "delete_file"]);
    assert.deepEqual(request.options.forgeTools.context.allowed_write_prefixes, ["docs/", "Skills/", "workflows/"]);
    assert.match(request.prompt, /ARCHITECTURE\.md, docs\/, Skills\/, or workflows\//);
    assert.match(request.prompt, /workflows\/agents\/architecture\/README\.md/);
    if (provider === "codex" || provider === "openai") assert.equal(request.options.forgeTools.registry.list_files.execute instanceof Function, true);
    else {
      assert.equal(request.options.mcpServers.forge.type, "sdk");
      assert.ok(request.options.allowedTools.includes("mcp__forge__list_files"));
      for (const name of ["Read", "Glob", "Grep"]) assert.equal(request.options.allowedTools.includes(`mcp__forge__${name}`), false);
      assert.deepEqual(request.options.tools, []);
    }
  }
});

test("System Engineer exposes the same Forge discovery and engineering tools across all SDK providers", async () => {
  const expected = ["search_tree", "list_files", "search_text", "read_file", "read_lines", "write_diff", "edit_diff", "git_status", "git_diff", "run_check", "commit_changes", "push_commit"];
  for (const provider of ["openai", "codex", "claude", "anthropic"]) {
    let request;
    const profile = { agent_id: "engineer", agent_name: "Engineer", role: "system_engineer", provider };
    const sdk = { conversationMode: provider === "codex" ? "thread" : "history", execute: async (input) => { request = input; return { text: "ready" }; } };
    const gitService = { status: async () => "", diffWorkingTree: async () => "", commit: async () => ({ sha: "a".repeat(40) }), pushCommit: async (sha) => ({ sha }) };
    const testService = { runCheck: async () => ({ status: "passed" }) };
    const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => profile }, sdkGateways: { [provider]: sdk }, fallbackStream: async function* () {}, fileService: fileService(), conversationStateStore: memoryStateStore(), testService, gitService, projectRoot: "/project", projectLogger: () => {} });
    for await (const chunk of stream({ agentId: "engineer", payload: { text: "inspect" }, correlationId: `CORR-${provider}`, conversationId: `CONV-${provider}` })) assert.equal(chunk.text, "ready");
    const names = request.options.forgeTools.definitions.map(({ name }) => name);
    assert.deepEqual(names, expected, provider);
    for (const name of ["search_tree", "list_files", "search_text"]) assert.ok(names.includes(name), `${provider} must expose Forge search tool ${name}`);
    if (["claude", "anthropic"].includes(provider)) assert.deepEqual(request.options.allowedTools, names.map((name) => `mcp__forge__${name}`));
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
  assert.deepEqual(request.options.forgeTools.definitions.map(({ name }) => name), ["search_tree", "list_files", "search_text", "read_file", "read_lines", "write_diff", "edit_diff", "git_status", "git_diff", "run_check", "commit_changes", "push_commit"]);
  assert.equal(request.options.sandboxMode, "read-only");
  assert.equal(request.options.networkAccessEnabled, false);
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
  await assert.rejects(() => request.onEvent({ type: "item.started", item: { type: "mcp_tool_call", server: "filesystem", tool: "read_file" } }), { code: "TOOL_FORBIDDEN" });
  await assert.rejects(() => request.onEvent({ type: "item.started", item: { type: "mcp_tool_call", server: "forge", tool: "Bash" } }), { code: "TOOL_FORBIDDEN" });
});

test("System Engineer Claude uses Forge tools and does not enable built-in discovery", async () => {
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

test("Claude gateway exposes Forge search tools and no native search tools", async () => {
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

test("Architecture Manager may write documentation in chat while private and code paths stay blocked", async () => {
  const context = { task_id: "CORR-ARCH-DOCS", agent_identity: { role: "architecture_manager" }, capabilities: ["write_diff", "edit_diff", "delete_file"], allowed_write_paths: [], allowed_write_prefixes: ownerWritePrefixes("architecture_manager") };
  for (const path of ["ARCHITECTURE.md", "docs/architecture/decision.md", "Skills/architecture/SKILL.md", "workflows/sprint.workflow.json"]) {
    await authorizeOwnerTool("write_diff", { path }, context, process.cwd());
    await authorizeOwnerTool("edit_diff", { path }, context, process.cwd());
  }
  await authorizeOwnerTool("delete_file", { path: "workflows/sprint.workflow.json" }, context, process.cwd());
  await assert.rejects(() => authorizeOwnerTool("delete_file", { path: "docs/architecture/decision.md" }, context, process.cwd()), (error) => error.code === "TOOL_FORBIDDEN");
  for (const path of ["AGENTS.md", "backend/src/app.js", "docs/.env", "docs/../backend/app.js", "docs/secret.key"]) {
    await assert.rejects(() => authorizeOwnerTool("write_diff", { path }, context, process.cwd()), (error) => error.code === "TOOL_FORBIDDEN");
  }
  const coder = { ...context, agent_identity: { role: "coder" }, allowed_write_prefixes: ownerWritePrefixes("coder") };
  await assert.rejects(() => authorizeOwnerTool("write_diff", { path: "docs/architecture/decision.md" }, coder, process.cwd()), (error) => error.code === "TOOL_FORBIDDEN");
});

test("OpenAI Agents SDK registers callable Forge functions for owner conversations", async () => {
  let agentOptions;
  const profile = { agent_id: "architect", agent_name: "Architect", role: "architecture_manager", model: "gpt-test", reasoning: { effort: "none" } };
  const gateway = createOpenAiSdkGateway({ providerFactory: { createForAgent: async () => ({ provider: { close: async () => {} }, profile }) }, AgentClass: class { constructor(options) { agentOptions = options; } }, runner: async () => ({ finalOutput: "done" }) });
  const result = await gateway.execute({ agent: profile, prompt: "inspect", correlationId: "CORR-OPENAI", options: { forgeTools: { definitions: [{ name: "list_files", description: "List files", input_schema: { type: "object", properties: {}, additionalProperties: false } }], registry: { list_files: { execute: async () => ({ stdout: "a.js" }) } }, context: {} } } });
  assert.equal(agentOptions.tools[0].name, "list_files");
  assert.equal(typeof agentOptions.tools[0].invoke, "function");
  assert.deepEqual(JSON.parse(await agentOptions.tools[0].invoke(new RunContext(), "{}")), { stdout: "a.js" });
  assert.equal(result.text, "done");
});

test("OpenAI Agents SDK registers the native shell tool only when owner search is enabled", async () => {
  let agentOptions;
  const profile = { agent_id: "engineer", agent_name: "Engineer", role: "system_engineer", model: "gpt-test", reasoning: { effort: "none" } };
  const gateway = createOpenAiSdkGateway({ providerFactory: { createForAgent: async () => ({ provider: { close: async () => {} }, profile }) }, AgentClass: class { constructor(options) { agentOptions = options; } }, runner: async () => ({ finalOutput: "done" }) });
  const shell = { run: async ({ commands }) => ({ output: [{ stdout: commands.join("\n"), stderr: "", outcome: { type: "exit", exitCode: 0 } }] }) };
  await gateway.execute({ agent: profile, prompt: "search", correlationId: "CORR-OPENAI-SHELL", options: { builtinSearchShell: shell } });
  const builtin = agentOptions.tools.find((candidate) => candidate.type === "shell");
  assert.ok(builtin);
  assert.equal((await builtin.shell.run({ commands: ["rg --files"] })).output[0].stdout, "rg --files");
});

test("OpenAI built-in shell accepts bounded project search and rejects command composition", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "nodeforge-search-shell-"));
  const logs = [];
  try {
    const shell = createOwnerBuiltinSearchShell({ projectRoot, logger: (event) => logs.push(event) });
    await assert.rejects(() => shell.run({ commands: ["rg --files; rm -rf ."] }), /single rg or find/);
    await assert.rejects(() => shell.run({ commands: ["find . -exec cat /etc/passwd"] }), /read-only find/);
    assert.deepEqual(logs.map(({ status, error_code }) => [status, error_code]), [["failed", "SEARCH_COMMAND_FORBIDDEN"], ["failed", "SEARCH_COMMAND_FORBIDDEN"]]);
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});

test("search_tree includes empty folders and filters hidden or secret paths", async () => {
  const tree = createOwnerSearchTreeTool({ fileService: { listDirectories: async () => ["backend", "backend/empty", "node_modules", ".forge", "backend/.private"], listFiles: async () => ["backend/app.js", "backend/.env", "backend/key.pem", "node_modules/pkg.js"] } });
  const result = await tree.execute({ path: "backend", max_depth: 2 });
  assert.deepEqual(result.entries, [{ path: "backend/app.js", type: "file" }, { path: "backend/empty", type: "directory" }]);
  await assert.rejects(() => tree.execute({ path: "../outside" }), /inside the project/);
});

test("Claude gateway passes the owner MCP server without cloning its live instance", async () => {
  let options;
  const profile = { agent_id: "architect", agent_name: "Architect", role: "architecture_manager", provider: "anthropic", model: "claude-test", gateway_url: "https://example.test/v1", credential_ref: "test", enabled: true, status: "ready" };
  const gateway = createClaudeSdkGateway({ configuration: { getById: () => profile }, credentialResolver: async () => "secret", queryFn: ({ options: received }) => { options = received; return (async function* () { yield { type: "assistant", message: { content: [{ type: "text", text: "Found file." }] } }; })(); } });
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => profile }, sdkGateways: { anthropic: gateway }, fallbackStream: async function* () {}, fileService: fileService(), projectRoot: process.cwd(), projectLogger: () => {} });
  const chunks = [];
  for await (const chunk of stream({ agentId: "architect", payload: { text: "find files" }, correlationId: "CORR-CLAUDE", conversationId: "CONV-CLAUDE" })) chunks.push(chunk.text);
  assert.equal(options.mcpServers.forge.type, "sdk");
      assert.ok(options.allowedTools.includes("mcp__forge__list_files"));
  assert.equal(options.forgeTools, undefined);
  assert.deepEqual(chunks, ["Found file."]);
});

test("Architecture Manager delete invalidates the shared code cache after File Service success", async () => {
  const content = "old\n";
  const invalidations = [];
  const tool = createOwnerDeleteFileTool({
    fileService: { readFile: async () => content, deleteFile: async () => ({ deleted: true }) },
    codeCache: { invalidate: (input) => invalidations.push(input) }
  });
  const checksum = `sha256:${(await import("node:crypto")).createHash("sha256").update(content).digest("hex")}`;
  assert.deepEqual(await tool.execute({ path: "workflows/old.md", before_checksum: checksum }), { deleted: true });
  assert.deepEqual(invalidations, [{ path: "workflows/old.md" }]);
  const failing = createOwnerDeleteFileTool({
    fileService: { readFile: async () => content, deleteFile: async () => { throw new Error("delete failed"); } },
    codeCache: { invalidate: (input) => invalidations.push(input) }
  });
  await assert.rejects(failing.execute({ path: "workflows/old.md", before_checksum: checksum }), /delete failed/);
  assert.equal(invalidations.length, 1);
});

test("read_file returns cached Markdown content for Architecture and Coder while code stays metadata-only", async () => {
  const reads = [];
  const markdown = Array.from({ length: 193 }, (_, index) => `plan line ${index + 1}`).join("\n");
  const codeCache = { read: async ({ path }) => { reads.push(path); return { path, content: path.endsWith(".md") ? markdown : "const value = 1;\n", code_index: { path, symbols: [] } }; } };
  const read = createReadFileTool({ fileService: { readForIndex: async () => { throw new Error("Cache should serve this read."); } }, codeCache });
  for (const role of ["architecture_manager", "coder"]) {
    const result = await read.execute({ path: "workflows/plan.md" }, { agent_identity: { role } });
    assert.equal(result.content, markdown);
    assert.equal(result.truncated, false);
    assert.equal(result.total_lines, 193);
  }
  const code = await read.execute({ path: "backend/src/example.js" }, { agent_identity: { role: "architecture_manager" } });
  assert.equal(code.content, undefined);
  assert.deepEqual(reads, ["workflows/plan.md", "workflows/plan.md", "backend/src/example.js"]);
});

test("read_file permits a 250-line Markdown window and keeps source windows at 80 lines", async () => {
  const markdown = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\n");
  const read = createReadFileTool({ fileService: { readForIndex: async ({ path }) => ({ path, content: path.endsWith(".md") ? markdown : "const value = 1;\n" }) } });
  const context = { agent_identity: { role: "architecture_manager" } };
  const first = await read.execute({ path: "workflows/long.md" }, context);
  assert.equal(first.content.split("\n").length, 250);
  assert.equal(first.truncated, true);
  const remainder = await read.execute({ path: "workflows/long.md", offset: 251, limit: 250 }, context);
  assert.equal(remainder.content.split("\n").length, 50);
  const sdkWindow = await read.execute({ path: "workflows/long.md", offset: 1, limit: 250, symbol: null }, context);
  assert.equal(sdkWindow.content.split("\n").length, 250);
  const emptySymbol = await read.execute({ path: "workflows/long.md", offset: 1, limit: 250, symbol: "" }, context);
  assert.equal(emptySymbol.content, sdkWindow.content);
  const unusedSymbol = await read.execute({ path: "workflows/long.md", offset: 1, limit: 250, symbol: "target" }, context);
  assert.equal(unusedSymbol.content, sdkWindow.content);
  await assert.rejects(() => read.execute({ path: "backend/code.js", offset: 1, limit: 10, symbol: "target" }, context), (error) => error.code === "INPUT_INVALID");
  await assert.rejects(() => read.execute({ path: "backend/code.js", offset: 1, limit: 250 }, context), (error) => error.code === "INPUT_INVALID");
});

test("Architecture reads Markdown checksum through its Forge registry and edits that document", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "nodeforge-owner-markdown-"));
  try {
    const fileService = createFileService({ projectRoot });
    await fileService.atomicWrite({ path: "workflows/plan.md", content: "# Plan\nOld decision\n", replace: true });
    const context = { task_id: "TASK-ARCH-MD", agent_identity: { role: "architecture_manager", agent_id: "architect" }, capabilities: ["read_file", "edit_diff"], allowed_write_prefixes: ["workflows/"] };
    const { registry } = createOwnerConversationTools({ role: "architecture_manager", projectRoot, fileService, context, projectLogger: () => {} });
    const read = await registry.read_file.execute({ path: "workflows/plan.md", offset: 1, limit: 250, symbol: "unused" });
    assert.equal(read.content, "# Plan\nOld decision\n");
    assert.match(read.sha256, /^sha256:[a-f0-9]{64}$/);
    await registry.edit_diff.execute({ path: "workflows/plan.md", before_checksum: read.sha256, anchor: "Old decision", replacement: "New decision" });
    assert.equal(await fileService.readFile({ path: "workflows/plan.md" }), "# Plan\nNew decision\n");
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});
