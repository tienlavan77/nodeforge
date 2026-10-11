// Verifies the shared engineering catalog preserves owner policy and schema-equivalent discovery aliases.
import assert from "node:assert/strict";
import test from "node:test";
import { ENGINEERING_TOOL_NAMES, ENGINEERING_ALIASES, engineeringToolDefinitions, engineeringToolReadiness } from "../../src/tools/engineering-tool-catalog.js";
import { createOwnerConversationTools } from "../../src/tools/owner-conversation-tools.js";
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

test("System Engineer uses all twelve shared schemas without changing its owner ledger handlers", () => {
  const { definitions } = createOwnerConversationTools(ownerServices("system_engineer"));
  assert.deepEqual(definitions.map(({ name }) => name), ENGINEERING_TOOL_NAMES);
  for (const definition of engineeringToolDefinitions()) assert.deepEqual(definitions.find(({ name }) => name === definition.name).input_schema, definition.input_schema);
  assert.equal(definitions.find(({ name }) => name === "commit_changes").input_schema.additionalProperties, false);
  assert.equal(definitions.find(({ name }) => name === "commit_changes").input_schema.properties.paths, undefined);
});

test("shared descriptors do not grant owner Coder write, verification, commit or push permissions", () => {
  const { definitions } = createOwnerConversationTools(ownerServices("coder"));
  assert.deepEqual(definitions.map(({ name }) => name), ["search_tree", "list_files", "search_text", "read_file", "read_lines"]);
});

test("legacy discovery aliases have identical argument schemas", () => {
  const definitions = engineeringToolDefinitions();
  for (const legacy of [rgFilesDefinition, rgSearchDefinition, sedLinesDefinition]) {
    assert.deepEqual(definitions.find(({ name }) => name === ENGINEERING_ALIASES[legacy.name]).input_schema, legacy.input_schema);
  }
});

test("readiness distinguishes missing grants from missing compatible services", () => {
  const status = engineeringToolReadiness({ capabilities: ["run_check", "read_file"], registry: { read_file: { execute() {} } } });
  assert.equal(status.catalog_version, "forge-engineering-v1");
  assert.deepEqual(status.tools.find(({ name }) => name === "read_file"), { name: "read_file", state: "available", reason: null });
  assert.match(status.tools.find(({ name }) => name === "run_check").reason, /service/);
  assert.match(status.tools.find(({ name }) => name === "push_commit").reason, /not granted/);
});

test("canonical discovery names consume the same governed discovery budget categories", async () => {
  for (const [name, kind] of [["search_tree", "search"], ["list_files", "search"], ["search_text", "search"], ["read_lines", "read"]]) assert.equal(discoveryKind(name), kind);
  const governance = createRuntimeToolGovernance();
  const context = governance.createExecutionContext({ task_id: "BUDGET", execution_id: "BUDGET-EXEC", agent_identity: { agent_id: "CODER", role: "coder" }, capabilities: ["search_tree"], allowed_prefixes: ["backend/"], context_budget: { max_calls: 5, max_bytes: 10000 }, discovery_search_calls: 1, discovery_budget: 1, allow_discovery_escalation: false, lifecycle: "RUNNING" });
  let calls = 0;
  await governance.dispatch("search_tree", {}, context, async () => { calls += 1; return { entries: [] }; });
  await assert.rejects(governance.dispatch("search_tree", {}, context, async () => { calls += 1; return {}; }));
  assert.equal(calls, 1);
});

test("canonical aliases invoke the original governed service with its internal capability", async () => {
  const old = Object.fromEntries(["rg_files", "rg_search", "sed_lines"].map((name) => [name, { execute: async (input, context) => ({ input, context, name }) }]));
  const tools = engineeringToolImplementations({ registry: old });
  for (const [alias, name] of Object.entries(ENGINEERING_ALIASES)) {
    const result = await tools[name].execute({}, { task_id: "T", capabilities: [name] });
    assert.equal(result.name, alias);
    assert.deepEqual(result.context.capabilities, [name, alias]);
  }
});

test("ticket tree exposes approved files and ancestors, not unrelated project areas", async () => {
  const tools = engineeringToolImplementations({ registry: {}, wrap: (tool) => tool, fileService: {
    listFiles: async () => ["backend/src/allowed.js", "backend/src/unrelated.js", "ui/private.js", ".forge/secret"],
    listDirectories: async () => ["backend", "backend/src", "ui", ".forge"]
  } });
  const result = await tools.search_tree.execute({}, { agent_identity: { role: "coder" }, allowed_file_paths: ["backend/src/allowed.js"], allowed_prefixes: [] });
  assert.deepEqual(result.entries.map(({ path }) => path), ["backend", "backend/src", "backend/src/allowed.js"]);
});
