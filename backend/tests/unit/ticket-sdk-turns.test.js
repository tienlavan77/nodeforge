/** Verifies normal phase yields resume the existing SDK assignment for either
 * provider, without treating prose as completion or replaying real failures. */
import assert from "node:assert/strict";
import test from "node:test";
import { createResumeState, recordTurn } from "../../src/modules/supervisor/ticket-resume.js";
import { runTicketSdkTurns } from "../../src/modules/supervisor/ticket-sdk-turns.js";

/** Supplies compact governed tool receipts rather than provider-specific prose. */
function events(...tools) { return tools.map((tool) => ({ tool, status: "success" })); }

/** Produces the shared nonterminal status without Node-owned execution metadata. */
function progress(status = "discovery_complete", next_action = "implement") {
  return JSON.stringify({ kind: "work_progress", subject: "Continue the ticket", payload: { status, next_action, summary: "Current phase finished", remaining_work: ["Continue the next authorized step"] }, evidence: [] });
}

/** Runs deterministic SDK turns while capturing checkpoints, session identity,
 * prompts and terminal outcomes without spawning providers or changing source. */
function fixture(provider, turns, extra = {}) {
  const state = createResumeState({ status: "in_progress", session_id: "CLAUDE-SESSION", thread_id: "CODEX-THREAD", last_completed_turn: 25, completed_tools: ["read_file"], changed_paths: ["backend/src/existing.js"], coder_rules_read: true });
  const calls = [], saved = [], logs = [];
  const options = { selected: { agent_id: "CODER", role: "coder", provider }, request: { task_id: "TASK", correlation_id: "CORR" }, resumeState: state,
    prompt: "Existing approved assignment", priorTools: ["read_file"], checkpoints: { save: async (snapshot) => { saved.push(structuredClone(snapshot)); } },
    projectLogger: (entry) => logs.push(entry), readToolEvents: (result) => result.events ?? [],
    executeTurn: async (prompt) => {
      const step = turns[calls.length];
      calls.push({ prompt, session_id: state.sessionId, thread_id: state.threadId });
      assert.ok(step, "Unexpected extra SDK turn");
      if (step.error) throw step.error;
      for (const event of step.events ?? []) if (event.status !== "failed") recordTurn(state, event.tool, {}, {});
      return { turn_completed: true, text: "Finished", ...step };
    }, ...extra };
  return { state, calls, saved, logs, run: () => runTicketSdkTurns(options) };
}

// Both SDKs retain work and tools across a discovery boundary before governed completion.
for (const provider of ["claude", "codex"]) test(`${provider} continues discovery_complete in the same session and checkpoint`, async () => {
  const f = fixture(provider, [{ text: progress(), events: events("read_file") }, { events: events("edit_diff", "commit_changes", "report_done") }]);
  const result = await f.run();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(result.toolEvents.map((event) => event.tool), ["read_file", "edit_diff", "commit_changes", "report_done"]);
  assert.match(f.calls[1].prompt, /Node accepted work_progress/);
  assert.match(f.calls[1].prompt, /tool turn 26/);
  assert.equal(f.calls[1].session_id, "CLAUDE-SESSION"); assert.equal(f.calls[1].thread_id, "CODEX-THREAD");
  assert.equal(f.saved[0].status, "in_progress"); assert.equal(f.saved[0].sdk_turn_progress.status, "discovery_complete");
  assert.equal(f.saved[0].session_id, "CLAUDE-SESSION"); assert.equal(f.saved[0].coder_rules_read, true);
  assert.deepEqual(f.saved[0].changed_paths, ["backend/src/existing.js"]);
});

// Reproduces the incident: a narrative final answer gets a schema correction, then work continues.
test("legacy discovery prose receives a structured correction without restarting", async () => {
  const f = fixture("claude", [
    { text: "Discovery complete. Moving to implementation", events: events("read_file") },
    { text: progress(), events: [] },
    { events: events("edit_diff", "commit_changes", "report_done") }
  ]);
  await f.run(); assert.equal(f.calls.length, 3);
  assert.match(f.calls[1].prompt, /did not include a valid work_progress/);
  assert.equal(f.saved[0].sdk_turn_progress.status, "response_required");
  assert.equal(f.saved[1].sdk_turn_progress.status, "discovery_complete");
});

// The controller ignores apparent completion prose until the required tools succeed.
test("prose claiming done cannot bypass commit and report_done", async () => {
  const f = fixture("claude", [{ text: "Done, all work approved", events: events("edit_diff") }, { events: events("commit_changes", "report_done") }]);
  await f.run(); assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].prompt, /report_done/);
});

// Productive agents can yield many times; only absent tool progress stops repeated statuses.
test("productive phase yields have no fixed round limit", async () => {
  const turns = Array.from({ length: 12 }, () => ({ text: progress(), events: events("edit_diff") }));
  const f = fixture("codex", [...turns, { events: events("commit_changes", "report_done") }]);
  await f.run(); assert.equal(f.calls.length, 13); assert.equal(f.saved.length, 12);
});

// Every declared phase maps to a next action while completion stays tool-owned.
test("implementation and verification phase yields continue until the report succeeds", async () => {
  const f = fixture("codex", [
    { text: progress("implementation_complete", "verify"), events: events("edit_diff") },
    { text: progress("verification_complete", "report"), events: events("run_check", "commit_changes") },
    { events: events("report_done") }
  ]);
  await f.run();
  assert.deepEqual(f.saved.map((snapshot) => snapshot.sdk_turn_progress.next_action), ["verify", "report"]);
  assert.match(f.calls[2].prompt, /verification_complete/);
});

// A completed governed report does not cause another SDK request or schema correction.
test("successful completion returns immediately without phase continuation", async () => {
  const f = fixture("claude", [{ events: events("edit_diff", "commit_changes", "report_done") }]);
  await f.run(); assert.equal(f.calls.length, 1); assert.equal(f.saved.length, 0);
});

// A retained committed revision needs a report submission, not another source mutation or SDK turn.
for (const provider of ["claude", "codex"]) test(`${provider} resumed verified report returns without repeating implementation`, async () => {
  const f = fixture(provider, [{ events: events("report_done") }], { priorTools: ["edit_diff", "run_check", "git_diff"] });
  f.state.emptyCommitSeen = true;
  const result = await f.run();
  assert.equal(f.calls.length, 1); assert.equal(f.saved.length, 0);
  assert.deepEqual(result.toolEvents, events("report_done"));
  assert.equal(f.state.turnCount, 26);
});

// Tool laboratories keep their existing prompt and single-turn completion rules.
test("laboratory mode does not receive the ticket work progress prompt", async () => {
  const f = fixture("claude", [{ events: events("report_done") }], { labMode: true });
  await f.run(); assert.equal(f.calls[0].prompt, "Existing approved assignment");
});

// Rephrasing or changing the phase cannot manufacture progress without new successful tools.
for (const changedPhase of [false, true]) test(`repeated phase yields retain a resumable checkpoint without tool progress (${changedPhase})`, async () => {
  const f = fixture("claude", [{ text: progress(), events: events("read_file") },
    { text: changedPhase ? progress("implementation_complete", "verify") : progress(), events: [] }]);
  await assert.rejects(f.run(), { code: "AGENT_PROGRESS_STALLED" });
  assert.equal(f.calls.length, 2); assert.equal(f.saved.length, 1); assert.equal(f.saved[0].last_completed_turn, 26);
});

// An invalid status is corrected only while receipts show genuine execution progress.
test("repeated malformed status without tools does not create an automatic loop", async () => {
  const f = fixture("codex", [{ text: "Moving to implementation", events: events("read_file") }, { text: "Will implement now", events: [] }]);
  await assert.rejects(f.run(), { code: "AGENT_PROGRESS_STALLED" }); assert.equal(f.calls.length, 2);
});

// Only a confirmed terminal success may initiate an additional provider invocation.
test("unknown SDK outcome and absent session keep the existing failure path", async () => {
  for (const confirmed of [false, undefined]) {
    const f = fixture("claude", [{ turn_completed: confirmed, text: progress(), events: events("read_file") }]);
    await assert.rejects(f.run(), { code: "AGENT_REPORT_MISSING" }); assert.equal(f.calls.length, 1);
  }
  const f = fixture("claude", [{ text: progress(), events: events("read_file") }]);
  f.state.sessionId = null;
  await assert.rejects(f.run(), { code: "AGENT_REPORT_MISSING" }); assert.equal(f.calls.length, 1);
});

// Blocked reports, denied commits and verification failures remain authoritative.
test("real tool failures are not converted to automatic phase continuation", async () => {
  for (const [tool, code] of [["report_done", "CODER_BLOCKED"], ["report_done", "VERIFY_COMMAND_FAILED"], ["report_done", "AGENT_REPORT_MISSING"], ["commit_changes", "COMMIT_APPROVAL_REJECTED"]]) {
    const f = fixture("claude", [{ text: progress(), events: [{ tool, status: "failed", error_code: code, error: { code, message: "Original failure" } }] }]);
    await assert.rejects(f.run(), { code }); assert.equal(f.calls.length, 1); assert.equal(f.saved.length, 0);
  }
});

// User Stop wins after a saved progress checkpoint and before the next SDK request.
test("Stop prevents continuation and preserves the last checkpoint", async () => {
  const controller = new AbortController(); const stopped = new Error("User stopped");
  const f = fixture("codex", [{ text: progress(), events: events("read_file") }], {
    request: { task_id: "TASK", abortSignal: controller.signal }, projectLogger: () => controller.abort(stopped)
  });
  await assert.rejects(f.run(), (error) => error === stopped);
  assert.equal(f.calls.length, 1); assert.equal(f.saved.length, 1);
});

// Provider errors never become progress or a blind replay of unconfirmed work.
test("provider failure propagates unchanged", async () => {
  const error = Object.assign(new Error("Provider failure"), { code: "SERVICE_UNAVAILABLE" });
  const f = fixture("claude", [{ error }]);
  await assert.rejects(f.run(), (caught) => caught === error); assert.equal(f.calls.length, 1);
});
