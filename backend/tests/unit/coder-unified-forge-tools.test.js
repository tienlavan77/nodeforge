// Verifies Coder provider parity, canonical source reading, checkpoints and native-tool refusal.
import assert from "node:assert/strict";
import test from "node:test";
import { createNodeforgeTaskExecutors } from "../../src/modules/supervisor/nodeforge-task-executors.js";
import { CODER_TOOL_NAMES, coderToolDefinitions } from "../../src/tools/engineering-tool-catalog.js";
import { createRuntimeToolGovernance } from "../../src/modules/governance/runtime-tool-governance.js";
import { createReadFileTool } from "../../src/tools/agent-lifecycle-tools.js";
import { checkpointedRegistry, createResumeState } from "../../src/modules/supervisor/ticket-resume.js";

// Creates a provider boundary fixture without launching models or mutating a live ticket.
function fixture(governance) {
  const requests = {};
  const registry = Object.fromEntries([...CODER_TOOL_NAMES, "search_code", "run_test", "check_test"].map((name) => [name, { execute: async () => ({ content: "source", exit_code: 0 }) }]));
  const executors = createNodeforgeTaskExecutors({ projectRoot: process.cwd(), projectLogger: () => {}, toolRegistry: registry,
    runtimeGovernance: governance ?? { createExecutionContext: (context) => context },
    claudeSdkGateway: { execute: async (request) => {
      requests.claude = request;
      return { messages: [{ type: "assistant", message: { content: ["read_lines", "edit_diff", "commit_changes", "report_done"].map((name) => ({ type: "tool_use", id: name, name: `mcp__forge__${name}` })) } }] };
    } },
    codexSdkGateway: { execute: async (request) => {
      requests.codex = request;
      for (const tool of ["read_lines", "edit_diff", "commit_changes", "report_done"]) await request.onEvent({ type: "item.completed", item: { type: "mcp_tool_call", server: "forge", tool, status: "completed" } });
      return { text: "done" };
    } }
  });
  return { executors, requests };
}

test("Claude and Codex ticket executors expose the System Engineer catalog with identical canonical names", async () => {
  const { executors, requests } = fixture();
  const request = { task_id: "T", request_id: "R", correlation_id: "C", payload: {}, ticket: { title: "Fix backend behavior", objective: "Correct backend response", acceptance_criteria: ["Returns the correct response"] } };
  await executors.runToolTicket({ agent_id: "A", role: "coder", provider: "claude" }, request);
  await executors.runCodexTask({ agent_id: "A", role: "coder", provider: "codex" }, request);
  assert.deepEqual(requests.claude.options.allowedTools.map((name) => name.replace("mcp__forge__", "")).sort(), requests.codex.options.forgeTools.definitions.map(({ name }) => name).sort());
  assert.deepEqual(requests.codex.options.forgeTools.definitions.map(({ name }) => name), CODER_TOOL_NAMES);
  const listTools = requests.claude.options.mcpServers.forge.instance.server._requestHandlers.get("tools/list");
  const exposed = await listTools({ method: "tools/list", params: {} }, {});
  assert.deepEqual(exposed.tools.map(({ name }) => name), CODER_TOOL_NAMES);
  for (const definition of coderToolDefinitions()) assert.deepEqual(requests.codex.options.forgeTools.definitions.find(({ name }) => name === definition.name).input_schema, definition.input_schema);
  assert.equal(requests.claude.options.tools.length, 0);
  assert.equal(requests.codex.options.sandboxMode, "read-only");
  const response = { responses: [{ finding_id: "REV-2", position: "dispute", rationale: "Existing source is already verified", files: [], evidence_refs: ["ARTIFACT-1"] }],
    review_commit_sha: "a".repeat(40), artifact_id: "ARTIFACT-1", source_revision: "sha256:source", idempotency_key: "RESPONSE-1" };
  assert.ok(requests.codex.options.forgeTools.context.capabilities.includes("respond_to_review"));
  await requests.codex.options.forgeTools.registry.respond_to_review.execute(response);
  const callTool = requests.claude.options.mcpServers.forge.instance.server._requestHandlers.get("tools/call");
  const delivered = await callTool({ method: "tools/call", params: { name: "respond_to_review", arguments: response } }, {});
  assert.notEqual(delivered.isError, true);
  const invalidReport = await callTool({ method: "tools/call", params: { name: "report_done", arguments: { status: "blocked", summary: "Missing blocker evidence" } } }, {});
  assert.equal(invalidReport.isError, true);
  assert.match(invalidReport.content[0].text, /TOOL_INPUT_INVALID/);
  for (const provider of ["claude", "codex"]) assert.doesNotMatch(requests[provider].prompt, /\b(?:Glob|Grep|sed_lines|rg_files|rg_search)\b/);
  await requests.codex.options.forgeTools.registry.push_commit.execute({ commit_sha: "a".repeat(40) });
  for (const type of ["command_execution", "file_change", "local_shell_call"]) await assert.rejects(requests.codex.onEvent({ type: "item.started", item: { type } }), { code: "TOOL_FORBIDDEN" });
});

test("Coder can inspect seven distinct windows without an independent read quota", async () => {
  const governance = createRuntimeToolGovernance();
  const { executors, requests } = fixture(governance);
  await executors.runCodexTask({ agent_id: "A", role: "coder", provider: "codex" }, { task_id: "T", request_id: "R", correlation_id: "C", payload: {}, ticket: { title: "Fix backend behavior", objective: "Correct backend response", acceptance_criteria: ["Returns the correct response"] } });
  const context = requests.codex.options.forgeTools.context;
  assert.equal(context.exploration_state.read_limit, null);
  assert.equal(context.exploration_state.search_limit, null);
  assert.ok(Number.isInteger(context.exploration_state.discovery_limit));
  for (let index = 1; index <= 7; index++) {
    await governance.dispatch("read_lines", { path: "backend/example.js", start_line: index, end_line: index }, context, async () => ({ stdout: `line ${index}`, exit_code: 0 }));
  }
  await assert.rejects(governance.dispatch("sed_lines", {}, context, async () => ({})), { code: "TOOL_FORBIDDEN" });
});

test("legacy checkpoints resume with equivalent canonical names without relabeling semantic-search evidence", () => {
  const state = createResumeState({ status: "in_progress", completed_tools: ["rg_files", "rg_search", "sed_lines", "search_code", "commit_changes"], turn_history: [{ tool: "sed_lines", turn: 1, target: "backend/a.js", outcome: "ok" }], changed_paths: ["backend/a.js"], session_id: "SESSION" });
  assert.deepEqual(state.completedTools, ["list_files", "search_text", "read_lines", "search_code", "commit_changes"]);
  assert.equal(state.turnHistory[0].tool, "read_lines");
  assert.equal(state.sessionId, "SESSION");
  assert.deepEqual(state.changedPaths, ["backend/a.js"]);
});

test("Coder canonical read_file returns bounded source, checksum and scope denial", async () => {
  const tool = createReadFileTool({ fileService: { readForIndex: async () => ({ content: "const first = 1;\nconst second = 2;\n" }) } });
  const context = { task_id: "T", agent_identity: { role: "coder" }, allowed_file_paths: ["backend/example.js"], allowed_prefixes: [] };
  const result = await tool.execute({ path: "backend/example.js", offset: 2, limit: 1 }, context);
  assert.equal(result.content, "const second = 2;");
  assert.match(result.sha256, /^sha256:[a-f0-9]{64}$/);
  await assert.rejects(tool.execute({ path: "backend/other.js", offset: 1, limit: 1 }, context));
});

test("canonical read_lines satisfies Coder rules and is recorded before editing on resume", async () => {
  const state = createResumeState(null);
  const saved = [];
  const registry = checkpointedRegistry({ store: { save: async (record) => saved.push(record) }, registry: {
    read_lines: { execute: async () => ({ stdout: "rules", exit_code: 0 }) }, edit_diff: { execute: async () => ({}) }
  }, taskId: "T", selected: { role: "coder" }, resumeState: state });
  const context = { changed_paths: [] };
  await registry.read_lines.execute({ path: "workflows/agents/coder/README.md", start_line: 1, end_line: 20 }, context);
  await registry.edit_diff.execute({ path: "backend/example.js" }, context);
  assert.equal(saved[0].coder_rules_read, true);
  assert.deepEqual(saved[1].completed_tools, ["read_lines", "edit_diff"]);
});
