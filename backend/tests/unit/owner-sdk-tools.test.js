// Summary: Confirms owner conversations expose governed Forge tools through each provider SDK contract.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";
import { createOpenAiSdkGateway } from "../../src/modules/agent/openai-sdk-gateway.js";
import { createOwnerSearchTreeTool } from "../../src/tools/owner-search-tree.js";
import { RunContext } from "@openai/agents";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";
import { authorizeOwnerTool, ownerWritePrefixes } from "../../src/tools/owner-role-tool-policy.js";

// Builds a minimal project file service so Owner tools can be registered without touching disk.
function fileService() { return { readFile() {}, readForIndex() {}, atomicWrite() {}, deleteFile() {}, listDirectories: async () => [], listFiles: async () => [] }; }

test("owner exposes the same approved Forge tools to OpenAI, Codex, Claude, and Anthropic", async () => {
  for (const provider of ["openai", "codex", "claude", "anthropic"]) {
    let request;
    const profile = { agent_id: "architect", role: "architecture_manager", provider };
    const sdk = { conversationMode: provider === "codex" ? "thread" : "history", execute: async (input) => { request = input; return { text: "ok" }; } };
    const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => profile }, sdkGateways: { [provider]: sdk }, fallbackStream: async function* () {}, fileService: fileService(), projectRoot: process.cwd(), projectLogger: () => {} });
    for await (const chunk of stream({ agentId: "architect", payload: { text: "inspect project" }, correlationId: `CORR-${provider}`, conversationId: `CONV-${provider}` })) assert.equal(typeof chunk.text, "string");
    assert.deepEqual(request.options.forgeTools.definitions.map(({ name }) => name), ["search_tree", "rg_files", "rg_search", "sed_lines", "read_file", "write_diff", "edit_diff", "delete_file"]);
    assert.deepEqual(request.options.forgeTools.context.allowed_write_prefixes, ["docs/", "Skills/", "workflows/"]);
    assert.match(request.prompt, /ARCHITECTURE\.md, docs\/, Skills\/, or workflows\//);
    if (provider === "codex" || provider === "openai") assert.equal(request.options.forgeTools.registry.rg_files.execute instanceof Function, true);
    else {
      assert.equal(request.options.mcpServers.forge.type, "sdk");
      assert.ok(request.options.allowedTools.includes("mcp__forge__rg_files"));
      for (const name of ["Read", "Glob", "Grep"]) assert.equal(request.options.allowedTools.includes(`mcp__forge__${name}`), false);
      assert.deepEqual(request.options.tools, []);
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
  const result = await gateway.execute({ agent: profile, prompt: "inspect", correlationId: "CORR-OPENAI", options: { forgeTools: { definitions: [{ name: "rg_files", description: "List files", input_schema: { type: "object", properties: {}, additionalProperties: false } }], registry: { rg_files: { execute: async () => ({ stdout: "a.js" }) } }, context: {} } } });
  assert.equal(agentOptions.tools[0].name, "rg_files");
  assert.equal(typeof agentOptions.tools[0].invoke, "function");
  assert.deepEqual(JSON.parse(await agentOptions.tools[0].invoke(new RunContext(), "{}")), { stdout: "a.js" });
  assert.equal(result.text, "done");
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
      assert.ok(options.allowedTools.includes("mcp__forge__rg_files"));
  assert.equal(options.forgeTools, undefined);
  assert.deepEqual(chunks, ["Found file."]);
});
