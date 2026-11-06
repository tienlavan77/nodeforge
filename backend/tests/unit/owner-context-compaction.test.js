// Business purpose: verifies unified context compaction and session/history
// rollover across System Engineer, Architecture Manager, and Coder roles for
// Anthropic/Claude, Codex, and OpenAI-compatible SDK providers.
// Technical description: tests token usage extraction from @openai/agents runs,
// owner session and history rollover thresholds, AM normal-chat session
// retention vs planning command isolation, and function-calling Coder history
// rollover at work_progress phase boundaries.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { shouldRolloverOwnerSession, formatOwnerCompactReceiptDigest, formatOwnerStructuredWorkHandoff, formatTurnBoundaryHistory } from "../../src/application/owner-context-compaction.js";
import { createOwnerExecutionCheckpoint } from "../../src/application/owner-execution-checkpoint.js";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createOpenAiSdkGateway } from "../../src/modules/agent/openai-sdk-gateway.js";
import { createOllamaSdkGateway } from "../../src/modules/agent/ollama-sdk-gateway.js";
import { createNodeforgeTaskExecutors } from "../../src/modules/supervisor/nodeforge-task-executors.js";
import { extractTurnInputTokens, shouldRolloverSdkSession } from "../../src/modules/supervisor/ticket/ticket-context-compaction.js";
import { CODER_TOOL_NAMES } from "../../src/tools/engineering-tool-catalog.js";

test("OpenAI SDK gateway extracts normalized usage from rawResponses and direct usage", async () => {
  const profile = { agent_id: "SE-OPENAI", agent_name: "SE OpenAI", role: "system_engineer", provider: "openai", model: "gpt-test", reasoning: { effort: "none" } };
  const gateway = createOpenAiSdkGateway({
    providerFactory: { createForAgent: async () => ({ provider: {}, profile }) },
    AgentClass: class { constructor(options) { this.options = options; } },
    runner: async () => ({
      finalOutput: "done",
      rawResponses: [
        { usage: { inputTokens: 80000, outputTokens: 1200, inputTokensDetails: { cachedTokens: 25000 } } },
        { usage: { input_tokens: 20000, output_tokens: 800, cached_input_tokens: 5000 } }
      ]
    })
  });

  const result = await gateway.execute({ agent: profile, prompt: "Inspect project", correlationId: "CORR-USAGE-1" });
  assert.deepEqual(result.usage, {
    input_tokens: 100000,
    output_tokens: 2000,
    cached_input_tokens: 30000
  });
  assert.equal(extractTurnInputTokens(result), 20000);

  const fallbackGateway = createOpenAiSdkGateway({
    providerFactory: { createForAgent: async () => ({ provider: {}, profile }) },
    AgentClass: class { constructor(options) { this.options = options; } },
    runner: async () => ({
      finalOutput: "done",
      state: { _context: { usage: { inputTokens: 180000, outputTokens: 1500, requests: 3 } } }
    })
  });
  const fallbackResult = await fallbackGateway.execute({ agent: profile, prompt: "Inspect fallback", correlationId: "CORR-USAGE-2" });
  assert.equal(fallbackResult.usage.requests, 3);
  assert.equal(extractTurnInputTokens(fallbackResult), 60000);
});

test("shouldRolloverOwnerSession supports both thread-backed and history-backed conversation state", () => {
  assert.equal(shouldRolloverOwnerSession({ sdk_thread_id: "sess-1", last_turn_input_tokens: 230000 }), true);
  assert.equal(shouldRolloverOwnerSession({ sdk_thread_id: null, sdk_history: [{ role: "User", text: "hi" }], last_turn_input_tokens: 230000 }), true);
  assert.equal(shouldRolloverOwnerSession({ sdk_thread_id: null, sdk_history: [], last_turn_input_tokens: 230000 }), false);
  assert.equal(shouldRolloverOwnerSession({ sdk_thread_id: "sess-1", last_turn_input_tokens: 230000 }, { planningInputOnly: true, threshold: 230000 }), true);
  assert.equal(shouldRolloverOwnerSession({ sdk_thread_id: "sess-1", last_turn_input_tokens: 230000 }, { continueExecution: true, threshold: 230000 }), true);
  assert.equal(shouldRolloverOwnerSession({ sdk_thread_id: "sess-1", last_turn_input_tokens: 80000 }), false);
  assert.equal(shouldRolloverOwnerSession({ sdk_thread_id: "sess-1", last_turn_input_tokens: 229999 }, { incomingText: "x" }), true);
  assert.equal(shouldRolloverOwnerSession({}, { history: [{ role: "User", text: "x".repeat(230000) }] }), true);
  assert.equal(shouldRolloverOwnerSession({ sdk_thread_id: "sess-1", last_turn_input_tokens: 229990 }, { incomingText: "short" }), false);
});

test("shouldRolloverSdkSession supports function-calling history runs when token threshold is reached", () => {
  const progress = { payload: { status: "phase_completed", next_action: "continue_ticket" } };
  const resumeState = { sessionId: null, threadId: null };
  const result = {
    usage: { input_tokens: 125000, cached_input_tokens: 35000 },
    history: [{ role: "user", content: "assignment" }, { role: "assistant", content: "phase 1" }]
  };
  assert.equal(shouldRolloverSdkSession({ result, progress, resumeState, threshold: 120000 }), true);
  assert.equal(shouldRolloverSdkSession({ result: { ...result, usage: { input_tokens: 90000, cached_input_tokens: 35000 } }, progress, resumeState, threshold: 120000 }), false);
  assert.equal(shouldRolloverSdkSession({ result: { ...result, history: [] }, progress, resumeState, threshold: 120000 }), false);
});

test("Owner SDK stream retains AM Anthropic session in normal chat and rolls over both AM and OpenAI history turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-owner-compaction-"));
  try {
    const fileService = createFileService({ projectRoot: root, logger: { error() {} } });
    const architectureCheckpoint = createOwnerExecutionCheckpoint({ fileService, role: "architecture_manager" });
    const executionCheckpoint = createOwnerExecutionCheckpoint({ fileService, role: "system_engineer" });
    const states = new Map();
    const stateStore = {
      async create({ conversationId, agentId }) {
        if (!states.has(conversationId)) states.set(conversationId, { conversation_id: conversationId, agent_id: agentId });
        return structuredClone(states.get(conversationId));
      },
      async get(conversationId) { return structuredClone(states.get(conversationId) ?? null); },
      async update(conversationId, patch) {
        const next = { ...(states.get(conversationId) ?? {}), ...structuredClone(patch) };
        states.set(conversationId, next);
        return structuredClone(next);
      }
    };
    const profiles = {
      "AM-CLAUDE": { agent_id: "AM-CLAUDE", agent_name: "AM Claude", role: "architecture_manager", provider: "anthropic", model: "claude-sonnet" },
      "SE-OPENAI": { agent_id: "SE-OPENAI", agent_name: "SE OpenAI", role: "system_engineer", provider: "openai", model: "gpt-5" }
    };
    const calls = [];
    const logs = [];
    const stream = createOwnerSdkStream({
      agentConfiguration: { getById: (id) => profiles[id] },
      sdkGateways: {
        anthropic: {
          conversationMode: "history",
          execute: async (req) => {
            calls.push(req);
            const nextSession = req.resumeSessionId ? req.resumeSessionId : `claude-am-session-${calls.length}`;
            req.onSessionReady?.(nextSession);
            return { text: `AM reply ${calls.length}`, session_id: nextSession, usage: { input_tokens: 230000 } };
          }
        },
        openai: {
          conversationMode: "history",
          execute: async (req) => {
            calls.push(req);
            return { text: `SE reply ${calls.length}`, usage: { input_tokens: 230000 } };
          }
        }
      },
      fallbackStream: async function* () {},
      conversationStateStore: stateStore,
      executionCheckpoint,
      architectureCheckpoint,
      fileService,
      projectRoot: root,
      projectLogger: (entry) => logs.push(entry)
    });

    // Turn 1: AM normal chat retains sdk_thread_id and last_turn_input_tokens.
    for await (const _ of stream({ agentId: "AM-CLAUDE", conversationId: "CONV-AM-1", correlationId: "EXEC-AM-1", payload: { message_id: "M1", text: "Review architecture" } })) { /* consume */ }
    const amState1 = await stateStore.get("CONV-AM-1");
    assert.equal(amState1.sdk_thread_id, "claude-am-session-1");
    assert.equal(amState1.last_turn_input_tokens, 230000);

    // Turn 2: AM exceeds token threshold (130k >= 120k), so it rolls over to a fresh session with Compact Receipt Digest.
    for await (const _ of stream({ agentId: "AM-CLAUDE", conversationId: "CONV-AM-1", correlationId: "EXEC-AM-2", payload: { message_id: "M2", text: "Continue architecture" } })) { /* consume */ }
    assert.equal(calls[1].resumeSessionId, undefined);
    assert.match(calls[1].prompt, /Session rolled over at token threshold \(230000 tokens\)/);
    const amState2 = await stateStore.get("CONV-AM-1");
    assert.equal(amState2.sdk_thread_id, "claude-am-session-2");
    assert.equal(amState2.compaction_rollover_count, 1);

    // Turn 3 & 4: SE on OpenAI (history mode without sdk_thread_id) tracks tokens and triggers history_rollover with Structured Work Handoff and no raw assistant prose from prior turns.
    for await (const _ of stream({ agentId: "SE-OPENAI", conversationId: "CONV-SE-1", correlationId: "EXEC-SE-1", payload: { message_id: "M3", text: "First OpenAI turn" } })) { /* consume */ }
    for await (const _ of stream({ agentId: "SE-OPENAI", conversationId: "CONV-SE-1", correlationId: "EXEC-SE-2", payload: { message_id: "M4", text: "Second OpenAI turn" } })) { /* consume */ }
    assert.match(calls[3].prompt, /Session rolled over at token threshold \(230000 tokens\)\. Structured Work Handoff:/);
    assert.doesNotMatch(calls[3].prompt, /Assistant: SE reply 3/);
    const rolloverLogs = logs.filter((entry) => entry.event_name === "owner.sdk_context_compacted");
    assert.equal(rolloverLogs.length, 2);
    assert.equal(rolloverLogs[0].payload.mode, "session_rollover");
    assert.equal(rolloverLogs[1].payload.mode, "history_rollover");
    assert.ok(formatOwnerCompactReceiptDigest({ state: amState2 }).includes("active_file_checksums"));
    assert.match(formatOwnerStructuredWorkHandoff({ profile: profiles["SE-OPENAI"], history: [{ role: "User", text: "Fix bug" }], state: amState2 }), /"provider":"openai"/);
    const boundedHistory = formatTurnBoundaryHistory([
      { role: "User", text: "A".repeat(5000) },
      { role: "Assistant", text: "B".repeat(5000) },
      { role: "User", text: "Recent question" }
    ], { maxChars: 6000, maxTurnChars: 3600 });
    assert.ok(boundedHistory.startsWith("Assistant: ") || boundedHistory.startsWith("User: "));
    assert.match(boundedHistory, /User: Recent question$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Function-calling Coder executor rolls over in-memory history and injects compacted rollover prompt when token threshold is reached", async () => {
  const runnerInputs = [];
  const logs = [];
  const profile = { agent_id: "CODER-OPENAI", agent_name: "Coder", role: "coder", provider: "openai", model: "gpt-test", reasoning: { effort: "none" } };
  const registry = Object.fromEntries(CODER_TOOL_NAMES.map((name) => [name, {
    execute: async (args, context) => {
      if (name === "write_diff") context.changed_paths.push(args.path);
      return { content: "ok", exit_code: 0, sha: "a".repeat(40) };
    }
  }]));
  const openai = createOpenAiSdkGateway({
    providerFactory: { createForAgent: async () => ({ provider: {}, profile }) },
    AgentClass: class { constructor(options) { this.options = options; } },
    runner: async (agent, input) => {
      runnerInputs.push(input);
      // Business purpose: executes a bound Forge tool inside the test runner double so tool receipts are recorded. Technical description: locates the tool by name on agent.options.tools and invokes it with serialized JSON arguments.
      const invoke = (name, args) => agent.options.tools.find((t) => t.name === name).invoke({}, JSON.stringify(args));
      if (runnerInputs.length === 1) {
        await invoke("read_file", { path: "backend/example.js" });
        return {
          finalOutput: JSON.stringify({
            kind: "work_progress",
            subject: "Read target complete",
            payload: { status: "discovery_complete", next_action: "implement", summary: "Read target", remaining_work: ["Edit and finish"] },
            evidence: []
          }),
          rawResponses: [{ usage: { inputTokens: 135000, outputTokens: 1000 } }],
          history: [{ role: "user", content: "old turn 1" }, { role: "assistant", content: "old reply 1" }]
        };
      }
      await invoke("write_diff", { path: "backend/example.js", content: "updated" });
      await invoke("run_check", { type: "test", command: "node --test backend/example.js" });
      await invoke("git_status", {});
      await invoke("git_diff", {});
      await invoke("commit_changes", { message: "feat: update" });
      await invoke("report_done", { summary: "done" });
      return {
        finalOutput: "completed",
        rawResponses: [{ usage: { inputTokens: 20000, outputTokens: 500 } }],
        history: [{ role: "user", content: "turn 2" }]
      };
    }
  });
  const executors = createNodeforgeTaskExecutors({
    openaiSdkGateway: openai,
    ollamaSdkGateway: createOllamaSdkGateway({ openaiSdkGateway: openai }),
    projectRoot: process.cwd(),
    projectLogger: (entry) => logs.push(entry),
    toolRegistry: registry,
    runtimeGovernance: { createExecutionContext: (input) => input },
    checkpoints: { save: async () => {}, complete: async () => {} }
  });

  await executors.runFunctionCallingTask(profile, {
    task_id: "TASK-1",
    request_id: "REQ-1",
    correlation_id: "CORR-1",
    ticket: { title: "Update example", objective: "Test rollover", acceptance_criteria: ["Passes"] },
    execution_context: { task_id: "TASK-1", approved_baseline: { file_checksums: { "backend/example.js": null } } },
    payload: {
      compaction_token_threshold: 120000
    }
  });

  assert.equal(runnerInputs.length, 2);
  // Turn 2 should have reset history (so input is a plain string prompt, not an array containing old history).
  assert.equal(typeof runnerInputs[1], "string");
  assert.match(runnerInputs[1], /COMPACTED SESSION HANDOFF \(Session rolled over at phase boundary to preserve context budget\)/);
  const compactedLog = logs.find((entry) => entry.event_name === "supervisor.sdk_context_compacted");
  assert.ok(compactedLog);
  assert.equal(compactedLog.payload.mode, "history_rollover");
  assert.equal(compactedLog.payload.input_tokens, 135000);
});
