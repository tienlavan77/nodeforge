import assert from "node:assert/strict";
import test from "node:test";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";

test("Supervisor dispatch sends an OpenAI profile through the SDK hello path", async () => {
  const logs = [];
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(),
    supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => {} },
    agentResolver: { resolveAvailable: () => ({ agent_id: "openai-1", agent_name: "OpenAI Builder", role: "coder", provider: "openai" }) },
    handoffQueue: { enqueue: async (request) => ({ id: `JOB-${request.task_id}` }) },
    openaiSdkGateway: {
      execute: async ({ agent, prompt, correlationId }) => {
        assert.equal(agent.agent_id, "openai-1");
        assert.match(prompt, /Say hello/);
        assert.equal(correlationId, "CORR-1");
        return { text: "Hello from OpenAI Builder." };
      }
    },
    projectLogger: (entry) => logs.push(entry)
  });

  const result = await integration.submitTicket({
    ticket: { id: "T-OPENAI-HELLO", project_id: "PROJECT-1", title: "Hello" },
    task_id: "T-OPENAI-HELLO",
    project_id: "PROJECT-1",
    request_id: "REQ-1",
    correlation_id: "CORR-1"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.response, "Hello from OpenAI Builder.");
  assert.equal(result.agent_id, "openai-1");
  assert.ok(logs.some((entry) => entry.event_name === "supervisor.agent_execution_completed"));
});

// Claude ticket runs cap reasoning effort so a single turn cannot spend
// minutes in extended thinking before the 600s SDK timeout.
test("Supervisor dispatch runs a Claude ticket with capped reasoning effort", async () => {
  let receivedOptions;
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(),
    supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => {} },
    agentResolver: { resolveAvailable: () => ({ agent_id: "claude-1", agent_name: "Claude Builder", role: "coder", provider: "claude" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB-CLAUDE" }) },
    toolRegistry: {
      read_file: { execute: async () => ({}) },
      write_diff: { execute: async () => ({}) },
      commit_changes: { execute: async () => ({}) },
      report_done: { execute: async () => ({}) }
    },
    runtimeGovernance: { createExecutionContext: (input) => ({ ...input, execution_id: "T-CLAUDE:REQ-CLAUDE", lifecycle: "RUNNING" }) },
    claudeSdkGateway: {
      execute: async ({ prompt, options }) => {
        receivedOptions = options;
        return {
          agent_id: "claude-1",
          agent_name: "Claude Builder",
          role: "coder",
          correlation_id: "CORR-CLAUDE",
          status: "completed",
          messages: [
            { role: "assistant", content: [{ type: "tool_use", name: "mcp__forge__read_file", input: { path: "backend/scripts/validate-schemas.mjs" } }] },
            { role: "assistant", content: [{ type: "tool_use", name: "mcp__forge__write_diff", input: { path: "backend/scripts/validate-schemas.mjs", content: "// summary", before_checksum: "abc" } }] },
            { role: "assistant", content: [{ type: "tool_use", name: "mcp__forge__commit_changes", input: { message: "Document validate-schemas" } }] },
            { role: "assistant", content: [{ type: "tool_use", name: "mcp__forge__report_done", input: { summary: "Done." } }] }
          ]
        };
      }
    }
  });

  const result = await integration.submitTicket({
    ticket: {
      id: "T-CLAUDE",
      project_id: "PROJECT-1",
      title: "Document validate-schemas",
      objective: "Document backend/scripts/validate-schemas.mjs behavior",
      acceptance_criteria: ["Update backend/scripts/validate-schemas.mjs documentation notes"]
    },
    task_id: "T-CLAUDE",
    request_id: "REQ-CLAUDE",
    correlation_id: "CORR-CLAUDE"
  });

  assert.equal(result.status, "completed");
  // "Document validate-schemas" (no explicit component location, backend path
  // mention) classifies as moderate.
  assert.equal(receivedOptions.effort, "medium");
  assert.equal(receivedOptions.maxTurns, 25);
  assert.deepEqual(receivedOptions.thinking, { type: "enabled", budgetTokens: 4096 });
});
