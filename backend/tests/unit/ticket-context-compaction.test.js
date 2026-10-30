// Business purpose: verifies Receipt-Preserving Context Compaction (Pieces A, B, and C) so Coder runs retain active file checksums across phase yields, compact oversized function-calling history into receipt stubs, and roll over SDK sessions at token thresholds without losing before_checksum evidence.
// Technical description: exercises activeFileChecksums, recordMutationChecksum, assertReadNotRepeated, formatActiveReceiptDigest, compactFunctionCallingHistory, shouldRolloverSdkSession, buildCompactedRolloverPrompt, and runTicketSdkTurns rollover behavior.
import assert from "node:assert/strict";
import test from "node:test";
import {
  activeFileChecksums,
  assertReadNotRepeated,
  createReadCache,
  recordMutationChecksum,
  rememberRead,
  sanitizeReadCache
} from "../../src/modules/supervisor/ticket/ticket-read-cache.js";
import {
  buildCompactedRolloverPrompt,
  compactFunctionCallingHistory,
  DEFAULT_ROLLOVER_INPUT_TOKENS,
  extractTurnInputTokens,
  formatActiveReceiptDigest,
  shouldRolloverSdkSession
} from "../../src/modules/supervisor/ticket/ticket-context-compaction.js";
import { buildResumePrompt, checkpointedRegistry, createResumeState, recordTurn } from "../../src/modules/supervisor/ticket/ticket-resume.js";
import { ticketWorkContinuationPrompt } from "../../src/modules/supervisor/ticket/ticket-work-progress.js";
import { runTicketSdkTurns } from "../../src/modules/supervisor/ticket/ticket-sdk-turns.js";

const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const SHA_C = `sha256:${"c".repeat(64)}`;

test("Piece A: read cache retains active file checksums across reads and mutations while allowing post-mutation window re-reads", () => {
  const cache = createReadCache();
  rememberRead(cache, { path: "backend/src/service.js", offset: 1, limit: 80 }, {
    path: "backend/src/service.js",
    content: "export const v = 1;\n",
    sha256: SHA_A,
    total_lines: 40,
    size_bytes: 200
  });
  assert.throws(
    () => assertReadNotRepeated(cache, { path: "backend/src/service.js", offset: 1, limit: 80 }),
    { code: "READ_REPEATED" }
  );
  assert.deepEqual(activeFileChecksums(cache), {
    "backend/src/service.js": { sha256: SHA_A, total_lines: 40, status: "read" }
  });

  // After edit_diff, the latest sha256 is recorded for before_checksum reuse, but re-reading the window is permitted.
  recordMutationChecksum(cache, {
    tool: "edit_diff",
    input: { path: "backend/src/service.js" },
    result: { path: "backend/src/service.js", sha256: SHA_B }
  });
  assert.doesNotThrow(() => assertReadNotRepeated(cache, { path: "backend/src/service.js", offset: 1, limit: 80 }));
  assert.deepEqual(activeFileChecksums(cache), {
    "backend/src/service.js": { sha256: SHA_B, status: "mutated:edit_diff" }
  });

  // write_diff text receipt format is also parsed into activeFileChecksums.
  recordMutationChecksum(cache, {
    tool: "write_diff",
    input: { path: "backend/src/new.js" },
    result: { content: [{ type: "text", text: `Written 'backend/src/new.js' (${SHA_C}).` }] }
  });
  assert.equal(activeFileChecksums(cache)["backend/src/new.js"].sha256, SHA_C);

  // move_file transfers the checksum to the destination path and drops the source path.
  recordMutationChecksum(cache, {
    tool: "move_file",
    input: { from_path: "backend/src/new.js", to_path: "backend/src/moved.js" },
    result: { sha256: SHA_C }
  });
  assert.equal(activeFileChecksums(cache)["backend/src/new.js"], undefined);
  assert.equal(activeFileChecksums(cache)["backend/src/moved.js"].sha256, SHA_C);

  // delete_file removes the path from active checksums.
  recordMutationChecksum(cache, { tool: "delete_file", input: { path: "backend/src/moved.js" } });
  assert.equal(activeFileChecksums(cache)["backend/src/moved.js"], undefined);

  const sanitized = sanitizeReadCache(cache);
  assert.equal(activeFileChecksums(sanitized)["backend/src/service.js"].sha256, SHA_B);
});

test("Piece A: continuation and resume prompts embed Active file checksums and formatActiveReceiptDigest stays bounded", async () => {
  const state = createResumeState({
    status: "in_progress",
    last_completed_turn: 3,
    completed_tools: ["read_file", "edit_diff"],
    changed_paths: ["backend/src/service.js"],
    coder_rules_read: true
  });
  const saved = [];
  const wrapped = checkpointedRegistry({
    store: { save: async (p) => saved.push(p), complete: async (_id, p) => saved.push(p) },
    registry: {
      read_file: { execute: async () => ({ path: "backend/src/service.js", content: "code", sha256: SHA_A, total_lines: 25 }) },
      edit_diff: { execute: async () => ({ path: "backend/src/service.js", sha256: SHA_B }) }
    },
    taskId: "TASK-A",
    selected: { agent_id: "CODER", role: "coder", provider: "claude" },
    correlationId: "CORR-A",
    resumeState: state
  });
  await wrapped.read_file.execute({ path: "backend/src/service.js", offset: 1, limit: 25 }, {});
  await wrapped.edit_diff.execute({ path: "backend/src/service.js", before_checksum: SHA_A, anchor: "a", replacement: "b" }, { changed_paths: ["backend/src/service.js"] });

  const continuation = ticketWorkContinuationPrompt({ payload: { status: "discovery_complete", next_action: "implement" } }, state);
  assert.match(continuation, /Active file checksums/);
  assert.match(continuation, new RegExp(SHA_B));

  const resumed = buildResumePrompt("Implement feature", state, { agentId: "CODER", provider: "claude" });
  assert.match(resumed, /Active file checksums/);
  assert.match(resumed, new RegExp(SHA_B));

  const digest = formatActiveReceiptDigest(state);
  assert.ok(digest.length <= 2000);
  assert.match(digest, new RegExp(SHA_B));
});

test("Piece B: compactFunctionCallingHistory replaces oversized intermediate tool outputs with structured receipt stubs while preserving initial and recent items", () => {
  const readCache = createReadCache();
  recordMutationChecksum(readCache, { tool: "edit_diff", input: { path: "backend/src/large.js" }, result: { sha256: SHA_B } });

  const hugeOutput = JSON.stringify({
    path: "backend/src/large.js",
    sha256: SHA_A,
    total_lines: 180,
    content: "x".repeat(5000)
  });
  const history = [
    { role: "user", content: "Initial ticket assignment prompt" },
    { type: "function_call_output", name: "read_file", output: hugeOutput },
    { type: "function_call_output", name: "search_text", output: JSON.stringify({ stdout: "line\n".repeat(400) }) },
    ...Array.from({ length: 6 }, (_, idx) => ({ role: "assistant", content: `recent-turn-${idx}` }))
  ];

  const result = compactFunctionCallingHistory(history, {
    readCache,
    changedPaths: ["backend/src/large.js"],
    maxHistoryBytes: 1024,
    preserveRecentItems: 6
  });

  assert.equal(result.compacted, true);
  assert.equal(result.compactedItems, 2);
  assert.ok(result.afterBytes < result.beforeBytes);
  assert.equal(result.history[0].content, "Initial ticket assignment prompt");
  assert.equal(result.history.at(-1).content, "recent-turn-5");

  const stub1 = JSON.parse(result.history[1].output);
  assert.equal(stub1.compacted_receipt, true);
  assert.equal(stub1.path, "backend/src/large.js");
  assert.equal(stub1.sha256, SHA_B);
  assert.equal(stub1.status, "retained_in_active_checksum_digest");
});

test("Piece C: shouldRolloverSdkSession and runTicketSdkTurns roll over sessionId/threadId at phase boundary when input_tokens reach threshold", async () => {
  assert.equal(extractTurnInputTokens({ usage: { input_tokens: 20000, cache_read_input_tokens: 105000 } }), 125000);
  const dummyState = createResumeState({ status: "in_progress", session_id: "SESS-1" });
  assert.equal(shouldRolloverSdkSession({
    result: { usage: { input_tokens: DEFAULT_ROLLOVER_INPUT_TOKENS } },
    progress: { payload: { status: "discovery_complete" } },
    resumeState: dummyState
  }), true);
  // Never rolls over on schema correction (when progress is undefined).
  assert.equal(shouldRolloverSdkSession({
    result: { usage: { input_tokens: DEFAULT_ROLLOVER_INPUT_TOKENS + 50000 } },
    progress: undefined,
    resumeState: dummyState
  }), false);

  const state = createResumeState({
    status: "in_progress",
    session_id: "CLAUDE-OLD-SESSION",
    last_completed_turn: 4,
    completed_tools: ["read_file"],
    changed_paths: ["backend/src/target.js"],
    coder_rules_read: true
  });
  rememberRead(state.readCache, { path: "backend/src/target.js", offset: 1, limit: 50 }, {
    path: "backend/src/target.js",
    content: "const a = 1;\n",
    sha256: SHA_A,
    total_lines: 50
  });

  const calls = [];
  const saved = [];
  const logs = [];
  const turns = [
    {
      text: JSON.stringify({
        kind: "work_progress",
        subject: "Discovery complete",
        payload: { status: "discovery_complete", next_action: "implement", summary: "Found target", remaining_work: ["Edit target"] },
        evidence: []
      }),
      usage: { input_tokens: 30000, cache_read_input_tokens: 95000 },
      events: [{ tool: "read_file", status: "success" }]
    },
    {
      text: "Completed ticket",
      usage: { input_tokens: 15000 },
      events: [
        { tool: "edit_diff", status: "success" },
        { tool: "commit_changes", status: "success" },
        { tool: "report_done", status: "success" }
      ]
    }
  ];

  await runTicketSdkTurns({
    selected: { agent_id: "CODER-1", role: "coder", provider: "claude" },
    request: { task_id: "TASK-ROLLOVER", correlation_id: "CORR-ROLLOVER", payload: { compaction_token_threshold: 120000 } },
    resumeState: state,
    prompt: "Original ticket assignment prompt",
    priorTools: ["read_file"],
    checkpoints: { save: async (snapshot) => saved.push(structuredClone(snapshot)) },
    projectLogger: (entry) => logs.push(entry),
    readToolEvents: (result) => result.events ?? [],
    executeTurn: async (turnPrompt) => {
      const step = turns[calls.length];
      calls.push({ prompt: turnPrompt, sessionId: state.sessionId });
      for (const ev of step.events ?? []) recordTurn(state, ev.tool, {}, {});
      return { turn_completed: true, ...step };
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].sessionId, "CLAUDE-OLD-SESSION");
  // Second turn runs with a fresh null sessionId after rollover and receives the compacted rollover handoff prompt.
  assert.equal(calls[1].sessionId, null);
  assert.match(calls[1].prompt, /COMPACTED SESSION HANDOFF/);
  assert.match(calls[1].prompt, /Original ticket assignment prompt/);
  assert.match(calls[1].prompt, new RegExp(SHA_A));
  assert.equal(saved[0].session_id, null);
  assert.equal(saved[0].sdk_turn_progress.rolled_over_from, "CLAUDE-OLD-SESSION");
  assert.equal(saved[0].sdk_turn_progress.compaction_rollover_count, 1);
  assert.ok(logs.some((entry) => entry.event_name === "supervisor.sdk_context_compacted" && entry.payload?.mode === "session_rollover"));

  const handoff = buildCompactedRolloverPrompt({
    basePrompt: "Base prompt",
    progress: { payload: { status: "discovery_complete", next_action: "implement" } },
    resumeState: state
  });
  assert.match(handoff, /COMPACTED SESSION HANDOFF/);
});
