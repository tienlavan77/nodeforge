// Verifies Coder provider parity, canonical source reading, checkpoints and native-tool refusal.
import assert from "node:assert/strict";
import test from "node:test";
import { createNodeforgeTaskExecutors } from "../../src/modules/supervisor/nodeforge-task-executors.js";
import { ENGINEERING_TOOL_NAMES, engineeringToolDefinitions } from "../../src/tools/engineering-tool-catalog.js";
import { createReadFileTool } from "../../src/tools/agent-lifecycle-tools.js";
import { checkpointedRegistry, createResumeState } from "../../src/modules/supervisor/ticket-resume.js";

// Creates a provider boundary fixture without launching models or mutating a live ticket.
function fixture() {
  const requests = {};
  const registry = Object.fromEntries([...ENGINEERING_TOOL_NAMES, "search_code", "run_test", "check_test", "report_done"].map((name) => [name, { execute: async () => ({ content: "source", exit_code: 0 }) }]));
  const executors = createNodeforgeTaskExecutors({ projectRoot: process.cwd(), projectLogger: () => {}, toolRegistry: registry,
    runtimeGovernance: { createExecutionContext: (context) => context },
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
  for (const definition of engineeringToolDefinitions()) assert.deepEqual(requests.codex.options.forgeTools.definitions.find(({ name }) => name === definition.name).input_schema, definition.input_schema);
  assert.equal(requests.claude.options.tools.length, 0);
  assert.equal(requests.codex.options.sandboxMode, "read-only");
  for (const provider of ["claude", "codex"]) assert.doesNotMatch(requests[provider].prompt, /\b(?:Glob|Grep|sed_lines|rg_files|rg_search)\b/);
  await requests.codex.options.forgeTools.registry.push_commit.execute({ commit_sha: "a".repeat(40) });
  for (const type of ["command_execution", "file_change", "local_shell_call"]) await assert.rejects(requests.codex.onEvent({ type: "item.started", item: { type } }), { code: "TOOL_FORBIDDEN" });
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
