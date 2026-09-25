// Summary: Covers ticketCandidateScope — SL-traced tickets bypass the legacy explore prepass.
import assert from "node:assert/strict";
import test from "node:test";
import { createNodeforgeTaskIntegration, ticketCandidateScope } from "../../src/modules/supervisor/nodeforge-task-integration.js";

// SL-traced tickets bypass the legacy explore prepass: the first PATCH path
// becomes the target and prefixes derive from every real candidate path.
test("ticketCandidateScope resolves PATCH first with candidate-derived prefixes", () => {
  const scope = ticketCandidateScope({
    candidate_files: [
      { path: "ui/nextjs/components/Panel.jsx", role: "REUSE", symbol: "ConversationList", reason: "reuse ConversationList" },
      { path: "backend/src/application/pin-service.js", role: "PATCH", symbol: "persistPin", reason: "edit persistPin" }
    ]
  });
  assert.equal(scope.targetPath, "backend/src/application/pin-service.js");
  assert.ok(scope.allowedPrefixes.includes("backend/src/application"));
  assert.ok(scope.allowedPrefixes.includes("ui/nextjs/components"));
});

test("ticketCandidateScope ignores legacy backfill placeholders", () => {
  const scope = ticketCandidateScope({
    candidate_files: [
      { path: "backend/src/application/ticket-crud-service.js", role: "REFERENCE", reason: "legacy-backfill: pre-enforcement ticket; retrieval must re-discover via live search." }
    ]
  });
  assert.equal(scope, null);
});

test("Claude dispatch bypasses explore prepass when SL candidates exist", async () => {
  let prepassCalls = 0;
  let receivedPrompt;
  const codexGateway = { execute: async () => { throw new Error("unused"); } };
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(),
    supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => {} },
    agentResolver: { resolveAvailable: () => ({ agent_id: "claude-sl", agent_name: "Claude Builder", role: "coder", provider: "claude" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB-SL" }) },
    toolRegistry: {
      read_file: { execute: async () => ({}) },
      write_diff: { execute: async () => ({}) },
      commit_changes: { execute: async () => ({}) },
      report_done: { execute: async () => ({}) }
    },
    runtimeGovernance: { createExecutionContext: (input) => ({ ...input, execution_id: "T-SL:REQ-SL", lifecycle: "RUNNING" }) },
    relevantTreeSelector: { select: async () => { prepassCalls += 1; throw new Error("prepass must be bypassed"); } },
    claudeSdkGateway: {
      execute: async ({ prompt }) => {
        receivedPrompt = prompt;
        return {
          agent_id: "claude-sl",
          agent_name: "Claude Builder",
          role: "coder",
          correlation_id: "CORR-SL",
          status: "completed",
          messages: [
            { role: "assistant", content: [{ type: "tool_use", name: "mcp__forge__read_file", input: { path: "backend/src/application/pin-service.js" } }] },
            { role: "assistant", content: [{ type: "tool_use", name: "mcp__forge__write_diff", input: { path: "backend/src/application/pin-service.js", content: "// summary", before_checksum: "abc" } }] },
            { role: "assistant", content: [{ type: "tool_use", name: "mcp__forge__commit_changes", input: { message: "Persist pin" } }] },
            { role: "assistant", content: [{ type: "tool_use", name: "mcp__forge__report_done", input: { summary: "Done." } }] }
          ]
        };
      }
    },
    codexSdkGateway: codexGateway
  });

  const result = await integration.submitTicket({
    ticket: {
      id: "T-SL",
      project_id: "PROJECT-1",
      title: "Pin conversations",
      objective: "Pin conversations",
      acceptance_criteria: ["pin works"],
      candidate_files: [
        { path: "backend/src/application/pin-service.js", role: "PATCH", symbol: "persistPin", reason: "edit persistPin" },
        { path: "ui/nextjs/components/Panel.jsx", role: "REUSE", symbol: "ConversationList", reason: "reuse ConversationList" }
      ]
    },
    task_id: "T-SL",
    request_id: "REQ-SL",
    correlation_id: "CORR-SL"
  });

  assert.equal(result.status, "completed");
  assert.equal(prepassCalls, 0);
  assert.match(receivedPrompt, /backend\/src\/application\/pin-service\.js/);
});

test("Codex dispatch bypasses explore prepass when SL candidates exist", async () => {
  let prepassCalls = 0;
  let forgeTools;
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(),
    supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => {} },
    agentResolver: { resolveAvailable: () => ({ agent_id: "codex-sl", agent_name: "Codex Builder", role: "coder", provider: "codex" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB-SL-CODEX" }) },
    toolRegistry: {
      sed_lines: { execute: async () => ({}) },
      write_diff: { execute: async () => ({}) },
      commit_changes: { execute: async () => ({}) },
      report_done: { execute: async () => ({}) }
    },
    runtimeGovernance: { createExecutionContext: (input) => ({ ...input, execution_id: "T-SL-CODEX:REQ-SL-CODEX", lifecycle: "RUNNING" }) },
    relevantTreeSelector: { select: async () => { prepassCalls += 1; throw new Error("prepass must be bypassed"); } },
    codexSdkGateway: {
      execute: async ({ options, onEvent }) => {
        forgeTools = options.forgeTools;
        for (const [tool, argumentsInput] of [
          ["sed_lines", { path: "backend/src/application/pin-service.js", start_line: 1, end_line: 40 }],
          ["write_diff", { path: "backend/src/application/pin-service.js" }],
          ["commit_changes", { message: "Persist pin" }],
          ["report_done", { summary: "Done." }]
        ]) {
          await onEvent({ type: "item.completed", item: { id: `${tool}-1`, type: "mcp_tool_call", server: "forge", tool, arguments: argumentsInput, result: { content: [] }, status: "completed" } });
        }
        return { text: "Done." };
      }
    }
  });

  const result = await integration.submitTicket({
    ticket: {
      id: "T-SL-CODEX",
      project_id: "PROJECT-1",
      title: "Pin conversations",
      objective: "Pin conversations",
      acceptance_criteria: ["pin works"],
      candidate_files: [
        { path: "backend/src/application/pin-service.js", role: "PATCH", symbol: "persistPin", reason: "edit persistPin" },
        { path: "ui/nextjs/components/Panel.jsx", role: "REUSE", symbol: "ConversationList", reason: "reuse ConversationList" }
      ]
    },
    task_id: "T-SL-CODEX",
    request_id: "REQ-SL-CODEX",
    correlation_id: "CORR-SL-CODEX"
  });

  assert.equal(result.status, "completed");
  assert.equal(prepassCalls, 0);
  assert.ok(forgeTools.context.allowed_prefixes.includes("backend/src/application"));
  assert.ok(forgeTools.context.allowed_prefixes.includes("ui/nextjs/components"));
});
