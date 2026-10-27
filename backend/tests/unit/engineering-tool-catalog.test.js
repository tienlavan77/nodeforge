// Verifies the shared engineering catalog preserves owner policy and schema-equivalent discovery aliases.
import assert from "node:assert/strict";
import test from "node:test";
import { ENGINEERING_TOOL_NAMES, CODER_TOOL_NAMES, ENGINEERING_ALIASES, engineeringToolDefinitions, coderToolDefinitions, engineeringToolReadiness } from "../../src/tools/engineering-tool-catalog.js";
import { createOwnerConversationTools } from "../../src/tools/owner-conversation-tools.js";
import { createForgeSdkMcpServer, forgeSdkToolNames } from "../../src/tools/claude-sdk-forge-tools.js";
import { rgFilesDefinition, rgSearchDefinition, sedLinesDefinition } from "../../src/tools/agent-command-tools.js";
import { engineeringToolImplementations } from "../../src/tools/engineering-tool-implementations.js";
import { discoveryKind } from "../../src/tools/exploration-state-factory.js";
import { createRuntimeToolGovernance } from "../../src/modules/governance/runtime-tool-governance.js";

// Supplies Node services without exercising provider SDKs or production repository mutation.
function ownerServices(role) {
  return { role, projectRoot: process.cwd(), fileService: { readFile() {}, readForIndex() {}, atomicWrite() {}, deleteFile() {}, listFiles() {}, listDirectories() {} },
    gitService: { status() {}, diffWorkingTree() {}, commit() {}, pushCommit() {} }, testService: { runCheck() {} },
    conversationStateStore: { get() {}, update() {} }, context: { task_id: "OWNER", capabilities: [...ENGINEERING_TOOL_NAMES], agent_identity: { role } } };
}

test("System Engineer uses the shared schemas without changing its owner ledger handlers", () => {
  const { definitions } = createOwnerConversationTools(ownerServices("system_engineer"));
  assert.deepEqual(definitions.map(({ name }) => name), ENGINEERING_TOOL_NAMES);
  for (const definition of engineeringToolDefinitions()) {
    const expected = structuredClone(definition.input_schema);
    if (definition.name === "search_text") {
      const issued = definitions.find(({ name }) => name === definition.name).input_schema.properties.paths.items.pattern;
      assert.equal(new RegExp(issued).test(".forge/runtime/evidence.json"), true);
      assert.equal(new RegExp(issued).test("../outside"), false);
      expected.properties.paths.items.pattern = issued;
    }
    assert.deepEqual(definitions.find(({ name }) => name === definition.name).input_schema, expected);
  }
  assert.equal(definitions.find(({ name }) => name === "commit_changes").input_schema.additionalProperties, false);
  assert.equal(definitions.find(({ name }) => name === "commit_changes").input_schema.properties.paths, undefined);
});

test("shared descriptors do not grant owner Coder write, verification, commit or push permissions", () => {
  const { definitions } = createOwnerConversationTools(ownerServices("coder"));
  assert.deepEqual(definitions.map(({ name }) => name), ["search_tree", "list_files", "search_text", "read_file", "read_lines", "lookup_schema"]);
});

test("legacy discovery aliases have identical argument schemas", () => {
  const definitions = engineeringToolDefinitions();
  for (const legacy of [rgFilesDefinition, rgSearchDefinition, sedLinesDefinition]) {
    assert.deepEqual(definitions.find(({ name }) => name === ENGINEERING_ALIASES[legacy.name]).input_schema, legacy.input_schema);
  }
});

test("readiness distinguishes missing grants from missing compatible services", () => {
  const status = engineeringToolReadiness({ capabilities: ["run_check", "read_file"], registry: { read_file: { execute() {} } } });
  assert.equal(status.catalog_version, "forge-engineering-v2");
  assert.deepEqual(status.tools.find(({ name }) => name === "read_file"), { name: "read_file", state: "available", reason: null });
  assert.match(status.tools.find(({ name }) => name === "run_check").reason, /service/);
  assert.match(status.tools.find(({ name }) => name === "push_commit").reason, /not granted/);
});

test("canonical discovery names consume the same governed discovery budget categories", async () => {
  for (const [name, kind] of [["search_tree", "search"], ["list_files", "search"], ["search_text", "search"], ["read_lines", "read"]]) assert.equal(discoveryKind(name), kind);
  const governance = createRuntimeToolGovernance();
  const context = governance.createExecutionContext({ task_id: "BUDGET", execution_id: "BUDGET-EXEC", agent_identity: { agent_id: "REVIEWER", role: "reviewer" }, capabilities: ["search_tree"], allowed_prefixes: ["backend/"], context_budget: { max_calls: 5, max_bytes: 10000 }, discovery_search_calls: 1, discovery_budget: 1, allow_discovery_escalation: false, lifecycle: "RUNNING" });
  let calls = 0;
  await governance.dispatch("search_tree", {}, context, async () => { calls += 1; return { entries: [] }; });
  await assert.rejects(governance.dispatch("search_tree", {}, context, async () => { calls += 1; return {}; }));
  assert.equal(calls, 1);
});

test("ticket tree exposes approved files and ancestors, not unrelated project areas", async () => {
  const tools = engineeringToolImplementations({ registry: {}, wrap: (tool) => tool, fileService: {
    listFiles: async () => ["backend/src/allowed.js", "backend/src/unrelated.js", "ui/private.js", ".forge/secret"],
    listDirectories: async () => ["backend", "backend/src", "ui", ".forge"]
  } });
  const result = await tools.search_tree.execute({}, { agent_identity: { role: "coder" }, allowed_file_paths: ["backend/src/allowed.js"], allowed_prefixes: [] });
  assert.deepEqual(result.entries.map(({ path }) => path), ["backend", "backend/src", "backend/src/allowed.js"]);
});

test("engineering and coder catalogs and SDK/MCP adapters include strict delete_file and move_file schemas", async () => {
  for (const list of [ENGINEERING_TOOL_NAMES, CODER_TOOL_NAMES]) {
    assert.ok(list.includes("delete_file"));
    assert.ok(list.includes("move_file"));
  }
  for (const definitions of [engineeringToolDefinitions(), coderToolDefinitions()]) {
    const deleteDef = definitions.find(({ name }) => name === "delete_file");
    const moveDef = definitions.find(({ name }) => name === "move_file");
    assert.ok(deleteDef && moveDef);
    assert.equal(deleteDef.input_schema.additionalProperties, false);
    assert.deepEqual(deleteDef.input_schema.required, ["path", "before_checksum"]);
    assert.match(deleteDef.input_schema.properties.before_checksum.pattern, /sha256/);
    assert.equal(moveDef.input_schema.additionalProperties, false);
    assert.deepEqual(moveDef.input_schema.required, ["from_path", "to_path", "before_checksum"]);
    assert.match(moveDef.input_schema.properties.before_checksum.pattern, /sha256/);
  }
  assert.ok(forgeSdkToolNames.includes("mcp__forge__delete_file"));
  assert.ok(forgeSdkToolNames.includes("mcp__forge__move_file"));
  const calls = [];
  const registry = Object.fromEntries(CODER_TOOL_NAMES.map((name) => [name, { execute: async (input) => { calls.push([name, input]); return { ok: true }; } }]));
  const server = createForgeSdkMcpServer({ registry, context: { task_id: "T-MUT" }, includeEngineeringTools: true });
  const callTool = server.instance.server._requestHandlers.get("tools/call");
  const validSha = `sha256:${"a".repeat(64)}`;
  const delRes = await callTool({ method: "tools/call", params: { name: "delete_file", arguments: { path: "src/old.js", before_checksum: validSha } } }, {});
  assert.equal(delRes.isError, undefined);
  const moveRes = await callTool({ method: "tools/call", params: { name: "move_file", arguments: { from_path: "src/old.js", to_path: "src/new.js", before_checksum: validSha } } }, {});
  assert.equal(moveRes.isError, undefined);
  const badSha = await callTool({ method: "tools/call", params: { name: "delete_file", arguments: { path: "src/old.js", before_checksum: "not-a-sha" } } }, {});
  assert.equal(badSha.isError, true);
});
