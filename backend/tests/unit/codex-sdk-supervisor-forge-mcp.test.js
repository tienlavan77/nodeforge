import assert from "node:assert/strict";
import test from "node:test";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";

// Ticket mode is delegated to the Codex SDK, with Forge tools exposed through MCP.
test("Supervisor dispatch runs a Codex ticket through the SDK Forge MCP path", async () => {
  const prompts = [];
  let forgeTools;
  let agentGatewayCalls = 0;
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(),
    supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => {} },
    agentResolver: { resolveAvailable: () => ({ agent_id: "codex-1", agent_name: "Codex Builder", role: "coder", provider: "codex" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB-CODEX" }) },
    toolRegistry: {
      sed_lines: { execute: async () => ({}) },
      rg_search: { execute: async () => ({ results: [] }) },
      write_diff: { execute: async () => ({}) },
      commit_changes: { execute: async () => ({}) },
      report_done: { execute: async () => ({}) }
    },
    runtimeGovernance: { createExecutionContext: (input) => ({ ...input, execution_id: "T-CODEX:REQ-CODEX", lifecycle: "RUNNING" }) },
    agentGateway: { request: async () => { agentGatewayCalls += 1; throw new Error("legacy gateway must not be called"); } },
    codexSdkGateway: {
      execute: async ({ prompt, options, onEvent }) => {
        prompts.push(prompt);
        forgeTools = options.forgeTools;
        for (const [tool, argumentsInput] of [
          ["sed_lines", { path: "backend/scripts/validate-schemas.mjs", start_line: 1, end_line: 40 }],
          ["write_diff", { path: "backend/scripts/validate-schemas.mjs" }],
          ["commit_changes", { message: "Document validate-schemas" }],
          ["report_done", { summary: "Added summary comment." }]
        ]) {
          await onEvent({
            type: "item.completed",
            item: {
              id: `${tool}-1`,
              type: "mcp_tool_call",
              server: "forge",
              tool,
              arguments: argumentsInput,
              result: { content: [{ type: "text", text: JSON.stringify({ summary: "ok" }) }] },
              status: "completed"
            }
          });
        }
        return { text: "Added summary comment." };
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
  assert.deepEqual(result.tool_events.map((entry) => entry.tool), ["sed_lines", "write_diff", "commit_changes", "report_done"]);
  assert.deepEqual(forgeTools.context.allowed_file_paths.filter((p) => p.endsWith(".mjs")), ["backend/scripts/validate-schemas.mjs"]);
  assert.match(prompts[0], /Document validate-schemas/);
  assert.match(prompts[0], /Read backend\/scripts\/validate-schemas\.mjs/);
  assert.doesNotMatch(prompts[0], /fixed six-tool/i);
  assert.deepEqual(forgeTools.definitions.map((tool) => tool.name), ["select_code_graph_candidates", "rg_files", "rg_search", "sed_lines", "write_diff", "edit_diff", "run_test", "check_test", "git_status", "git_diff", "commit_changes", "report_done"]);
  assert.equal(agentGatewayCalls, 0);
});

test("Watcher header UI ticket targets frontend scope instead of tool-lab marker", async () => {
  let forgeTools;
  let prompt;
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(),
    supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => {} },
    agentResolver: { resolveAvailable: () => ({ agent_id: "codex-ui", agent_name: "Codex UI", role: "coder", provider: "codex" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB-UI" }) },
    toolRegistry: {
      sed_lines: { execute: async () => ({}) },
      write_diff: { execute: async () => ({}) },
      commit_changes: { execute: async () => ({}) },
      report_done: { execute: async () => ({}) }
    },
    runtimeGovernance: { createExecutionContext: (input) => ({ ...input, execution_id: "T-UI:REQ-UI", lifecycle: "RUNNING" }) },
    codexSdkGateway: {
      execute: async ({ prompt: receivedPrompt, options, onEvent }) => {
        prompt = receivedPrompt;
        forgeTools = options.forgeTools;
        for (const [tool, argumentsInput] of [
          ["sed_lines", { path: "ui/nextjs/components/NodeForgePanels.jsx", start_line: 1, end_line: 40 }],
          ["write_diff", { path: "ui/nextjs/components/NodeForgePanels.jsx" }],
          ["commit_changes", { message: "Add watcher header agent status" }],
          ["report_done", { summary: "Added watcher header agent status." }]
        ]) {
          await onEvent({ type: "item.completed", item: { id: `${tool}-1`, type: "mcp_tool_call", server: "forge", tool, arguments: argumentsInput, result: { content: [] }, status: "completed" } });
        }
        return { text: "Added watcher header agent status." };
      }
    }
  });

  const result = await integration.submitTicket({
    ticket: {
      id: "TICKET-PROJECT-NODEFORGE-1789433096732",
      project_id: "PROJECT-NODEFORGE",
      title: "Add Agent Process Status to the Watcher Header",
      objective: "Update the watcher UI to display an agent process status line in the right side of the header, showing PID, RAM usage, CPU percentage, and uptime.",
      acceptance_criteria: [
        "The watcher header includes an agent process status area aligned to the right.",
        "The status area displays values in the format: PID | RAM | %CPU | Uptime.",
        "PID, RAM, CPU usage, and uptime are populated from the current agent process data.",
        "The status area remains readable and correctly aligned across supported screen sizes."
      ]
    },
    task_id: "TICKET-PROJECT-NODEFORGE-1789433096732",
    request_id: "REQ-UI",
    correlation_id: "CORR-UI"
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(forgeTools.context.allowed_file_paths, ["ui/nextjs/components/NodeForgePanels.jsx", "backend/package.json"]);
  assert.ok(forgeTools.context.allowed_prefixes.includes("ui/nextjs/"));
  assert.ok(forgeTools.context.allowed_prefixes.includes("ui/src/"));
  assert.ok(forgeTools.context.allowed_prefixes.includes("web/src/"));
  assert.equal(forgeTools.context.allowed_prefixes.includes("backend/"), false);
  assert.doesNotMatch(prompt, /backend\/tool-lab-target\.txt/);
});

test("payload.tool_test keeps the fixed six-tool Codex lab prompt", async () => {
  let prompt;
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(),
    supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => {} },
    agentResolver: { resolveAvailable: () => ({ agent_id: "codex-lab", agent_name: "Codex Lab", role: "coder", provider: "codex" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB-LAB" }) },
    toolRegistry: { report_done: { execute: async () => ({}) } },
    runtimeGovernance: { createExecutionContext: (input) => ({ ...input, execution_id: "T-LAB:REQ-LAB", lifecycle: "RUNNING" }) },
    codexSdkGateway: {
      execute: async ({ prompt: receivedPrompt, onEvent }) => {
        prompt = receivedPrompt;
        await onEvent({ type: "item.completed", item: { id: "report-1", type: "mcp_tool_call", server: "forge", tool: "report_done", arguments: { summary: "Tool lab completed" }, result: { content: [] }, status: "completed" } });
        return { text: "Tool lab completed" };
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

test("Real ticket without target path or UI intent fails instead of using tool-lab marker", async () => {
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(),
    supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => {} },
    agentResolver: { resolveAvailable: () => ({ agent_id: "codex-missing-target", agent_name: "Codex Missing Target", role: "coder", provider: "codex" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB-MISSING-TARGET" }) },
    toolRegistry: {},
    runtimeGovernance: { createExecutionContext: () => { throw new Error("governance must not run without target"); } },
    codexSdkGateway: { execute: async () => { throw new Error("gateway must not run without target"); } }
  });

  await assert.rejects(() => integration.submitTicket({
    ticket: { id: "T-NO-TARGET", project_id: "PROJECT-1", title: "Improve docs wording", objective: "Make the copy clearer", acceptance_criteria: ["Copy is clearer"] },
    task_id: "T-NO-TARGET",
    request_id: "REQ-NO-TARGET",
    correlation_id: "CORR-NO-TARGET"
  }), (error) => error.code === "TICKET_TARGET_MISSING");
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
    codexSdkGateway: { execute: async () => ({ text: "Forge MCP tools are not available" }) }
  });
  await assert.rejects(() => integration.submitTicket({ ticket: { id: "T-MISSING", title: "Tool lab", objective: "Run backend/scripts/validate-schemas.mjs lab", acceptance_criteria: ["Complete tool check for backend/scripts/validate-schemas.mjs"] }, task_id: "T-MISSING" }), (error) => error.code === "CODEX_MCP_TOOL_CALLS_MISSING");
});
