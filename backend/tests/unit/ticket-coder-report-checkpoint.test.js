// Ensures a completed Coder report remains resumable at Reviewer after an explanation tool call.
import assert from "node:assert/strict";
import test from "node:test";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";

// Runs a short Codex ticket with both report_done and respond_to_review in one SDK turn.
test("Coder checkpoint completes after report_done and review explanation", async () => {
  let checkpoint;
  const tools = ["sed_lines", "write_diff", "commit_changes", "report_done", "respond_to_review"];
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(),
    supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => {} },
    agentResolver: { resolveAvailable: () => ({ agent_id: "CODER-1", agent_name: "Coder", role: "coder", provider: "codex" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB-1" }) },
    toolRegistry: Object.fromEntries(tools.map((name) => [name, { execute: async () => ({ summary: "ok" }) }])),
    checkpointStore: {
      save: async (value) => { checkpoint = value; return value; },
      load: async () => checkpoint,
      complete: async (_taskId, details) => { checkpoint = { ...checkpoint, ...details, status: "completed" }; return checkpoint; }
    },
    runtimeGovernance: { createExecutionContext: (input) => ({ ...input, execution_id: "TICKET-1:REQ-1", lifecycle: "RUNNING" }) },
    codexSdkGateway: { execute: async ({ onEvent }) => {
      for (const tool of tools) await onEvent({ type: "item.completed", item: { id: `${tool}-1`, type: "mcp_tool_call", server: "forge", tool, arguments: { path: "ui/nextjs/app/page.jsx" }, result: { content: [] }, status: "completed" } });
      return { text: "Coder reported and explained the ticket." };
    } }
  });
  const result = await integration.submitTicket({ ticket: { id: "TICKET-1", project_id: "PROJECT-1", title: "Update page", objective: "Update ui/nextjs/app/page.jsx", acceptance_criteria: ["Page works"] }, task_id: "TICKET-1", request_id: "REQ-1", correlation_id: "CORR-1" });
  assert.equal(result.status, "completed");
  assert.equal(checkpoint.status, "completed");
  assert.equal(checkpoint.phase, "coder_reported");
});
