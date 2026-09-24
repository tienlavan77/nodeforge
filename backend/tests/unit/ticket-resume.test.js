import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResumePrompt,
  checkpointedRegistry,
  checkpointPayload,
  createResumeState,
  failureDetail,
  normalizeResume,
  recordTurn,
  remainingTurns
} from "../../src/modules/supervisor/ticket-resume.js";
import { createCodexSdkGateway } from "../../src/modules/agent/codex-sdk-gateway.js";

function memoryStore() {
  const saved = [];
  return {
    saved,
    save: async (record) => { saved.push({ ...record }); return record; },
    complete: async (taskId, record) => { saved.push({ task_id: taskId, ...record }); return record; }
  };
}

test("normalizeResume rejects completed or missing snapshots", () => {
  assert.equal(normalizeResume(null), null);
  assert.equal(normalizeResume({ status: "completed" }), null);
  assert.deepEqual(normalizeResume({ status: "in_progress" }), { status: "in_progress" });
});

test("createResumeState seeds turn count, tools, and paths from checkpoint", () => {
  const state = createResumeState({ status: "in_progress", last_completed_turn: 19, completed_tools: ["read_file"], changed_paths: ["a.js"], session_id: "sess-1", thread_id: "thread-1" }, { max_turns: 40 });
  assert.equal(state.turnCount, 19);
  assert.equal(state.sessionId, "sess-1");
  assert.equal(state.threadId, "thread-1");
  assert.deepEqual(state.changedPaths, ["a.js"]);
  assert.equal(remainingTurns(state), 21);
});

test("checkpoint saves keep session identity across every turn", async () => {
  const store = memoryStore();
  const registry = { read_file: { execute: async () => ({ ok: true, total_lines: 10 }) } };
  const state = createResumeState({ status: "in_progress", session_id: "sess-keep", last_completed_turn: 3, completed_tools: ["read_file"] }, { max_turns: 10 });
  const wrapped = checkpointedRegistry({ store, registry, taskId: "T-KEEP", targetPath: "a.js", allowedPrefixes: [], complexity: { max_turns: 10 }, selected: {}, correlationId: "C-1", resumeState: state });
  await wrapped.read_file.execute({ path: "a.js" }, { changed_paths: ["a.js"] });
  await wrapped.read_file.execute({ path: "a.js" }, { changed_paths: ["a.js"] });
  assert.equal(store.saved.length, 2);
  assert.equal(store.saved[0].session_id, "sess-keep");
  assert.equal(store.saved[1].session_id, "sess-keep");
  assert.equal(store.saved[1].last_completed_turn, 5);
  assert.ok(store.saved[1].turn_history.length >= 2);
});

test("resume restarts turn counting from the checkpoint, not zero", async () => {
  const store = memoryStore();
  const registry = { read_file: { execute: async () => ({ ok: true }) } };
  const state = createResumeState({ status: "in_progress", last_completed_turn: 19 }, { max_turns: 20 });
  const wrapped = checkpointedRegistry({ store, registry, taskId: "T-BUDGET", targetPath: "a.js", allowedPrefixes: [], complexity: { max_turns: 20 }, selected: {}, correlationId: "C-1", resumeState: state });
  await wrapped.read_file.execute({ path: "a.js" }, {});
  assert.equal(state.turnCount, 20);
  await assert.rejects(() => wrapped.read_file.execute({ path: "a.js" }, {}), /Turn limit reached/);
});

test("buildResumePrompt carries turn history and remaining budget", () => {
  const state = createResumeState({ status: "in_progress", last_completed_turn: 2, completed_tools: ["read_file"], session_id: "sess-2" }, { max_turns: 10 });
  recordTurn(state, "edit_diff", { path: "ui/nextjs/app/page.jsx" }, { ok: true });
  const prompt = buildResumePrompt("BASE-TICKET", state, { agentId: "agent-1", provider: "claude", changedPaths: ["ui/nextjs/app/page.jsx"] });
  assert.match(prompt, /turn 3 of 10/);
  assert.match(prompt, /7 turns remain/);
  assert.match(prompt, /edit_diff ui\/nextjs\/app\/page\.jsx/);
  assert.match(prompt, /BASE-TICKET/);
});

test("checkpointPayload merges session ids and failure details", () => {
  const state = createResumeState({ status: "in_progress", session_id: "sess-fail" }, { max_turns: 10 });
  const payload = checkpointPayload(state, { task_id: "T-FAIL", status: "in_progress", failure: failureDetail(Object.assign(new Error("boom"), { code: "TIMEOUT" })) });
  assert.equal(payload.session_id, "sess-fail");
  assert.equal(payload.failure.code, "TIMEOUT");
});

test("codex gateway resumes a prior thread when resumeThreadId is given", async () => {
  let resumedId = null;
  let started = false;
  const gateway = createCodexSdkGateway({
    configuration: { getById: () => ({ agent_id: "codex-r", agent_name: "Codex R", role: "coder", gateway_url: "https://gateway.test/v1/responses", credential_ref: "secret", enabled: true, status: "ready", model: "agentgw.cloud" }) },
    credentialResolver: () => "gateway-key",
    CodexClass: class FakeCodex {
      resumeThread(id) { resumedId = id; return { id: "thread-resumed", runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed", usage: null }; })() }) }; }
      startThread() { started = true; return { id: "thread-new", runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed", usage: null }; })() }) }; }
    }
  });
  const result = await gateway.execute({ agentId: "codex-r", correlationId: "CORR-R", prompt: "continue", resumeThreadId: "thread-old" });
  assert.equal(resumedId, "thread-old");
  assert.equal(started, false);
  assert.equal(result.thread_id, "thread-resumed");
});
