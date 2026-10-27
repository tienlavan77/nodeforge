// Summary: Confirms owner conversations expose governed Forge tools through each provider SDK contract.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";
import { createOpenAiSdkGateway } from "../../src/modules/agent/openai-sdk-gateway.js";
import { createOwnerSearchTreeTool } from "../../src/tools/owner-search-tree.js";
import { RunContext } from "@openai/agents";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";
import { authorizeOwnerTool, ownerWritePrefixes, ownerRoleTools } from "../../src/tools/owner-role-tool-policy.js";
import { createOwnerDeleteFileTool } from "../../src/tools/owner-delete-file.js";
import { createReadFileTool } from "../../src/tools/agent-lifecycle-tools.js";
import { createOwnerConversationTools } from "../../src/tools/owner-conversation-tools.js";
import { createOwnerBuiltinSearchShell } from "../../src/tools/owner-builtin-search-shell.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Proves planning admits only existing discovery plus authorized Git reads, never mutations.
test("Architecture Manager exposes executable Git reads in normal and planning contexts", async () => {
  assert.ok(ownerRoleTools("architecture_manager").includes("git_status"));
  assert.ok(ownerRoleTools("architecture_manager").includes("git_diff"));
  const calls = [];
  const gitService = { status: async () => { calls.push("status"); return " M backend/a.js\n"; }, diffWorkingTree: async () => { calls.push("diff"); return "diff content"; } };
  for (const planning_input_only of [false, true]) {
    const context = { task_id: "AM-GIT", planning_input_only, capabilities: [...ownerRoleTools("architecture_manager")], agent_identity: { role: "architecture_manager" } };
    const options = { role: "architecture_manager", projectRoot: process.cwd(), fileService: fileService(), context };
    const { registry } = createOwnerConversationTools({ ...options, gitService });
    assert.equal((await registry.git_status.execute({})).stdout, " M backend/a.js\n");
    assert.equal((await registry.git_diff.execute({})).stdout, "diff content");
    for (const name of ["run_check", "commit_changes", "push_commit", "shell"]) assert.equal(registry[name], undefined);
    assert.ok(registry.lookup_schema);
    for (const name of ["write_diff", "edit_diff", "delete_file"]) {
      assert.equal(Boolean(registry[name]), !planning_input_only);
      if (planning_input_only) await assert.rejects(() => authorizeOwnerTool(name, { path: "workflows/plan.md" }, context, process.cwd()), { code: "TOOL_FORBIDDEN" });
    }
    const unavailable = createOwnerConversationTools(options).registry;
    assert.equal(unavailable.git_status, undefined);
    assert.equal(unavailable.git_diff, undefined);
    await assert.rejects(() => registry.git_status.execute({}, { ...context, capabilities: [] }), { code: "TOOL_FORBIDDEN" });
  }
  assert.deepEqual(calls, ["status", "diff", "status", "diff"]);
});

// Checks published conversation schemas against real nested searches and SE-only runtime access.
test("owner search schemas and execution agree on nested directories and files", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-owner-search-"));
  try {
    await mkdir(join(root, "backend/src/tools"), { recursive: true });
    await mkdir(join(root, ".forge/runtime"), { recursive: true });
    await writeFile(join(root, "backend/src/tools/example.js"), "needle\n");
    await writeFile(join(root, ".forge/runtime/example.txt"), "needle\n");
    const shared = JSON.parse(await readFile(new URL("../../../schemas/agent/tools/rg-search.schema.json", import.meta.url), "utf8"));
    for (const role of ["architecture_manager", "reviewer", "system_engineer"]) {
      const context = { task_id: "OWNER-SEARCH", capabilities: ["search_text"], agent_identity: { role } };
      const { definitions, registry } = createOwnerConversationTools({ role, projectRoot: root, fileService: createFileService({ projectRoot: root }), context });
      const pattern = new RegExp(definitions.find(({ name }) => name === "search_text").input_schema.properties.paths.items.pattern);
      for (const path of ["backend", "backend/src/tools", "backend/src/tools/example.js"]) {
        assert.ok(pattern.test(path));
        assert.ok(new RegExp(shared.properties.paths.items.pattern).test(path));
        assert.match((await registry.search_text.execute({ pattern: "needle", paths: [path] })).stdout, /backend\/src\/tools\/example.js/);
      }
      for (const path of [".forge", ".forge/runtime", ".forge/runtime/example.txt"]) {
        assert.equal(pattern.test(path), role === "system_engineer");
        if (role === "system_engineer") assert.match((await registry.search_text.execute({ pattern: "needle", paths: [path] })).stdout, /\.forge\/runtime\/example.txt/);
        else await assert.rejects(() => registry.search_text.execute({ pattern: "needle", paths: [path] }));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Builds a minimal project file service so Owner tools can be registered without touching disk.
function fileService() { return { readFile() {}, readForIndex() {}, atomicWrite() {}, deleteFile() {}, listDirectories: async () => [], listFiles: async () => [] }; }

test("owner exposes the same approved Forge tools to OpenAI, Codex, Claude, Anthropic, and Ollama", async () => {
  for (const provider of ["openai", "codex", "claude", "anthropic", "ollama"]) {
    let request;
    const profile = { agent_id: "architect", role: "architecture_manager", provider };
    const sdk = { conversationMode: provider === "codex" ? "thread" : "history", builtinWebSearchAvailable: provider !== "ollama", execute: async (input) => { request = input; return { text: "ok" }; } };
    const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => profile }, sdkGateways: { [provider]: sdk }, fallbackStream: async function* () {}, fileService: fileService(), projectRoot: process.cwd(), projectLogger: () => {} });
    for await (const chunk of stream({ agentId: "architect", payload: { text: "inspect project" }, correlationId: `CORR-${provider}`, conversationId: `CONV-${provider}` })) assert.equal(typeof chunk.text, "string");
    assert.deepEqual(request.options.forgeTools.definitions.map(({ name }) => name), ["search_tree", "list_files", "search_text", "read_file", "read_lines", "write_diff", "edit_diff", "delete_file", "lookup_schema"]);
    assert.deepEqual(request.options.forgeTools.context.allowed_write_prefixes, ["docs/", "Skills/", "workflows/"]);
    assert.match(request.prompt, /ARCHITECTURE\.md, docs\/, Skills\/, or workflows\//);
    assert.match(request.prompt, /workflows\/agents\/architecture\/README\.md/);
    const webSearchAvailable = provider !== "ollama";
    assert.equal(request.options.builtinWebSearch, webSearchAvailable, provider);
    if (provider === "ollama") {
      assert.match(request.prompt, /does not support native web search/);
      assert.equal(request.options.builtinWebSearch, false);
    }
    if (["codex", "ollama", "openai"].includes(provider)) assert.equal(request.options.forgeTools.registry.list_files.execute instanceof Function, true);
    else {
      assert.equal(request.options.mcpServers.forge.type, "sdk");
      assert.ok(request.options.allowedTools.includes("mcp__forge__list_files"));
      for (const name of ["Read", "Glob", "Grep"]) assert.equal(request.options.allowedTools.includes(`mcp__forge__${name}`), false);
      assert.deepEqual(request.options.tools, ["WebSearch"]);
    }
  }
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
  const result = await gateway.execute({ agent: profile, prompt: "inspect", correlationId: "CORR-OPENAI", options: { builtinWebSearch: true, forgeTools: { definitions: [{ name: "list_files", description: "List files", input_schema: { type: "object", properties: {}, additionalProperties: false } }], registry: { list_files: { execute: async () => ({ stdout: "a.js" }) } }, context: {} } } });
  assert.equal(gateway.builtinWebSearchAvailable(profile), true);
  assert.equal(agentOptions.tools[0].type, "hosted_tool");
  assert.equal(agentOptions.tools[0].name, "web_search");
  assert.equal(agentOptions.tools[1].name, "list_files");
  assert.equal(typeof agentOptions.tools[1].invoke, "function");
  assert.deepEqual(JSON.parse(await agentOptions.tools[1].invoke(new RunContext(), "{}")), { stdout: "a.js" });
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
    if (role === "coder") await assert.rejects(() => read.execute({ path: "workflows/plan.md" }, { agent_identity: { role } }), { code: "PATH_FORBIDDEN" });
    const result = await read.execute({ path: "workflows/plan.md" }, { agent_identity: { role }, allowed_file_paths: ["workflows/plan.md"] });
    assert.equal(result.content, markdown);
    assert.equal(result.truncated, false);
    assert.equal(result.total_lines, 193);
  }
  const code = await read.execute({ path: "backend/src/example.js" }, { agent_identity: { role: "architecture_manager" } });
  assert.equal(code.content, undefined);
  assert.deepEqual(reads, ["workflows/plan.md", "workflows/plan.md", "backend/src/example.js"]);
});

test("read_file permits a 250-line Markdown window and keeps source windows at 250 lines", async () => {
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
  assert.equal((await read.execute({ path: "backend/code.js", offset: 1, limit: 250 }, context)).content, "const value = 1;\n");
  await assert.rejects(() => read.execute({ path: "backend/code.js", offset: 1, limit: 251 }, context), (error) => error.code === "INPUT_INVALID");
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
