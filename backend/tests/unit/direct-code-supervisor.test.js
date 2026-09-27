// Confirms Supervisor sends direct dashboard text to a ready governed coder without a target file.
import assert from "node:assert/strict";
import test from "node:test";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";

for (const provider of ["codex", "claude"]) {
  test(`direct Code selects a ${provider} coder and lets it discover the target`, async () => {
    const profile = { agent_id: `${provider}-coder`, agent_name: "Coder", role: "coder", provider, enabled: true, status: "ready" };
    let received;
    const gateway = { execute: async (request) => {
      received = request;
      if (provider === "codex") {
        for (const tool of ["rg_files", "write_diff", "commit_changes", "report_done"]) await request.onEvent({ type: "item.completed", item: { id: tool, type: "mcp_tool_call", server: "forge", tool, status: "completed" } });
        return { text: "Coder completed." };
      }
      return { messages: [{ type: "assistant", message: { content: ["mcp__forge__Glob", "mcp__forge__write_diff", "mcp__forge__commit_changes", "mcp__forge__report_done"].map((name) => ({ type: "tool_use", id: name, name })) } }] };
    } };
    const integration = createNodeforgeTaskIntegration({
      projectRoot: process.cwd(), supervisorManager: { startTask: async () => ({}) }, eventBus: { publish: async () => {} },
      agentResolver: { list: () => [{ agent_id: "openai-coder", role: "coder", provider: "openai", enabled: true, status: "ready" }, profile], resolveAvailable: () => { throw new Error("Direct Code must select a coding SDK."); } },
      handoffQueue: { enqueue: async () => ({ id: "JOB-CODE" }) }, toolRegistry: { Glob: { execute: async () => ({}) }, write_diff: { execute: async () => ({}) }, commit_changes: { execute: async () => ({}) }, report_done: { execute: async () => ({}) } },
      runtimeGovernance: { createExecutionContext: (input) => input }, ...(provider === "codex" ? { codexSdkGateway: gateway } : { claudeSdkGateway: gateway })
    });
    const text = "chỉnh sửa UI để nhả chữ mượt";
    const ticket = { id: "CODE-TEST", project_id: "PROJECT-1", title: text, objective: text, acceptance_criteria: [], required_role: "coder" };
    const result = await integration.submitTicket({ ticket, task_id: ticket.id, request_id: "REQ-CODE", correlation_id: "CORR-CODE", payload: { text, direct_code: true } });
    assert.equal(result.agent_id, profile.agent_id);
    assert.equal(result.status, "completed");
    assert.match(received.prompt, /chỉnh sửa UI để nhả chữ mượt/);
    assert.match(received.prompt, /workflows\/agents\/coder\.md/);
    const context = provider === "codex" ? received.options.forgeTools.context : null;
    if (context) {
      assert.equal(context.target_path, null);
      assert.ok(context.allowed_prefixes.includes("ui/"));
      assert.ok(context.allowed_file_paths.includes("vocabulary/glossary.md"));
      assert.ok(context.allowed_file_paths.includes("workflows/agents/coder.md"));
      assert.equal(received.options.forgeTools.definitions.some((tool) => tool.name === "select_code_graph_candidates"), false);
      assert.doesNotMatch(received.prompt, /select_code_graph_candidates/);
    } else {
      assert.deepEqual(received.options.tools, []);
      assert.ok(received.options.allowedTools.includes("mcp__forge__Glob"));
      assert.equal(received.options.allowedTools.includes("mcp__forge__select_code_graph_candidates"), false);
      assert.doesNotMatch(received.prompt, /select_code_graph_candidates/);
    }
  });
}

test("direct Code resume selects the original provider profile", async () => {
  let selectedAgent;
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(), supervisorManager: { startTask: async () => ({}) }, eventBus: { publish: async () => {} },
    agentResolver: { list: () => [
      { agent_id: "codex-first", role: "coder", provider: "codex", enabled: true, status: "ready" },
      { agent_id: "claude-original", role: "coder", provider: "claude", enabled: true, status: "ready" }
    ], resolveAvailable: () => undefined },
    handoffQueue: { enqueue: async () => ({ id: "JOB-RESUME" }) },
    toolRegistry: { report_done: { execute: async () => ({}) } },
    runtimeGovernance: { createExecutionContext: (input) => input },
    claudeSdkGateway: { execute: async (request) => { selectedAgent = request.agentId; return { messages: [{ type: "assistant", message: { content: ["write_diff", "commit_changes", "report_done"].map((name) => ({ type: "tool_use", name: `mcp__forge__${name}` })) } }] }; } }
  });
  const ticket = { id: "CODE-RESUME", project_id: "PROJECT-1", title: "Continue", objective: "Continue", acceptance_criteria: [], required_role: "coder" };
  await integration.submitTicket({ ticket, task_id: ticket.id, payload: { direct_code: true, resume_from: { agent_id: "claude-original", provider: "claude", status: "in_progress", last_completed_turn: 25 } } });
  assert.equal(selectedAgent, "claude-original");
});
