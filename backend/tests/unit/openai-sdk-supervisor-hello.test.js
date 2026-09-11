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

// Ticket mode: the Codex loop is driven through agentGateway function-calls
// with a prompt built from the real ticket content, not the fixed lab script.
test("Supervisor dispatch runs a Codex ticket through the Forge function-calling loop", async () => {
  const prompts = [];
  const executed = [];
  let toolsSent = null;
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(),
    supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => {} },
    agentResolver: { resolveAvailable: () => ({ agent_id: "codex-1", agent_name: "Codex Builder", role: "coder", provider: "codex" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB-CODEX" }) },
    toolRegistry: {
      read_file: { execute: async (input, context) => { executed.push({ name: "read_file", input, context }); return { path: input.path, content: "// file\n", sha256: "sha256:abc", size_bytes: 8, truncated: false }; } },
      search_code: { execute: async () => ({ results: [] }) },
      report_done: { execute: async (input) => { executed.push({ name: "report_done", input }); return { summary: input.summary }; } }
    },
    runtimeGovernance: { createExecutionContext: (input) => ({ ...input, execution_id: "T-CODEX:REQ-CODEX", lifecycle: "RUNNING" }) },
    agentGateway: {
      request: async ({ tools, payload }) => {
        prompts.push(payload.messages[0].content[0].text);
        toolsSent = tools;
        if (payload.messages.length === 1) return { payload: { tool_use: { id: "c1", name: "read_file", input: { path: "backend/scripts/validate-schemas.mjs" } } } };
        if (payload.messages.length >= 5) return { payload: { tool_use: { id: "c2", name: "report_done", input: { summary: "Added summary comment." } } } };
        return { payload: { tool_use: { id: `cx${payload.messages.length}`, name: "search_code", input: { query: "validate-schemas", kind: "file", limit: 5 } } } };
      }
    }
  });

  const result = await integration.submitTicket({
    ticket: { id: "T-CODEX", project_id: "PROJECT-1", title: "Document validate-schemas", objective: "Read backend/scripts/validate-schemas.mjs and prepend an English summary comment", acceptance_criteria: ["Comment at top of backend/scripts/validate-schemas.mjs"] },
    task_id: "T-CODEX",
    request_id: "REQ-CODEX",
    correlation_id: "CORR-CODEX"
  });

  assert.equal(result.response, "Added summary comment.");
  assert.deepEqual(executed.map((entry) => entry.name), ["read_file", "report_done"]);
  assert.deepEqual(executed[0].context.allowed_file_paths.filter((p) => p.endsWith(".mjs")), ["backend/scripts/validate-schemas.mjs"]);
  // The prompt carries the real ticket content, not the lab script.
  assert.match(prompts[0], /Document validate-schemas/);
  assert.match(prompts[0], /Read backend\/scripts\/validate-schemas\.mjs/);
  assert.doesNotMatch(prompts[0], /fixed six-tool/i);
  assert.deepEqual(toolsSent.map((tool) => tool.name), ["search_code", "read_file", "write_diff", "run_test", "commit_changes", "report_done"]);
});

// Lab mode stays as the six-tool integration harness when payload.tool_test is set.
test("payload.tool_test keeps the fixed six-tool Codex lab prompt", async () => {
  let prompt;
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(),
    supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => {} },
    agentResolver: { resolveAvailable: () => ({ agent_id: "codex-lab", agent_name: "Codex Lab", role: "coder", provider: "codex" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB-LAB" }) },
    toolRegistry: { report_done: { execute: async (input) => ({ summary: input.summary }) } },
    runtimeGovernance: { createExecutionContext: (input) => ({ ...input, execution_id: "T-LAB:REQ-LAB", lifecycle: "RUNNING" }) },
    agentGateway: {
      request: async ({ payload }) => {
        prompt ??= payload.messages[0].content[0].text;
        return { payload: { tool_use: { id: "c1", name: "report_done", input: { summary: "Tool lab completed" } } } };
      }
    }
  });

  const result = await integration.submitTicket({
    ticket: { id: "T-LAB", project_id: "PROJECT-1", title: "Tool lab" },
    task_id: "T-LAB",
    request_id: "REQ-LAB",
    correlation_id: "CORR-LAB",
    payload: { tool_test: { target_path: "backend/tool-lab-target.txt", allowed_prefixes: ["backend/"] } }
  });

  assert.equal(result.response, "Tool lab completed");
  assert.match(prompt, /fixed six-tool/i);
  assert.match(prompt, /do not inspect or use any ticket title, objective, description, or acceptance criteria/i);
});

test("Codex run fails when the provider never emits a Forge tool call", async () => {
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(),
    supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => {} },
    agentResolver: { resolveAvailable: () => ({ agent_id: "codex-missing", agent_name: "Codex Missing", role: "coder", provider: "codex" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB-MISSING" }) },
    toolRegistry: {},
    runtimeGovernance: { createExecutionContext: (input) => ({ ...input, execution_id: "T-MISSING:REQ-MISSING", lifecycle: "RUNNING" }) },
    agentGateway: { request: async () => ({ payload: { text: "Forge MCP tools are not available", tool_use: null } }) }
  });
  await assert.rejects(() => integration.submitTicket({ ticket: { id: "T-MISSING", title: "Tool lab" }, task_id: "T-MISSING" }), (error) => error.code === "CODEX_MCP_TOOL_CALLS_MISSING");
});
