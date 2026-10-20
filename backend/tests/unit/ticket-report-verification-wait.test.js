// Verifies durable report waits keep Coder sessions, source and Stop semantics while Node owns verification polling.
import assert from "node:assert/strict";
import test from "node:test";
import { checkpointedRegistry, createResumeState, buildResumePrompt } from "../../src/modules/supervisor/ticket-resume.js";
import { createReportDoneTool } from "../../src/tools/agent-report-tool.js";
import { createTicketVerificationRecovery } from "../../src/modules/supervisor/ticket-verification-recovery.js";

// Builds the actual report/checkpoint/recovery chain with controllable terminal verification evidence.
function fixture(provider, retained = null, failed = false) {
  const records = [];
  const events = [];
  const reports = [];
  let waiting;
  const began = new Promise((resolve) => { waiting = resolve; });
  const job = { job_id: "VERIFY-WAIT", status: "running", attempt: 2 };
  const artifact = { artifact_id: "ARTIFACT-WAIT", commit_sha: "a".repeat(40), changed_paths: ["backend/src/a.js"],
    file_checksums: { "backend/src/a.js": "sha256:a" }, commands: [{ kind: "lint", exit_code: 0, argv: ["lint"] }] };
  const diagnostic = { artifact_id: "ARTIFACT-FAIL", evidence_ref: "verification/ARTIFACT-FAIL.json", commands: [{ argv: ["lint"], exit_code: 1, stdout_redacted: "failed assertion" }] };
  const ensurePassedArtifact = createTicketVerificationRecovery({ taskId: "T-WAIT", pollMs: 1,
    executionContexts: { load: async () => ({ state: "committed", review_commit_sha: artifact.commit_sha, source_revision: "SOURCE" }) },
    assertIdentity: async () => {}, assertPassedArtifact: async () => {
      if (job.status !== "passed") throw Object.assign(new Error("Missing"), { code: "VERIFY_ARTIFACT_MISMATCH" });
      return artifact;
    }, startTests: async () => job, getTestResult: async () => job, getFailureDiagnostic: async () => diagnostic });
  const state = createResumeState(retained ?? { status: "in_progress", last_completed_turn: 12,
    completed_tools: ["edit_diff", "commit_changes"], thread_id: provider === "codex" ? "THREAD" : null,
    session_id: provider === "claude" ? "SESSION" : null, changed_paths: ["backend/src/a.js"] });
  const store = { save: async (record) => { records.push(JSON.parse(JSON.stringify(record))); if (record.phase === "verification_wait") waiting(); },
    complete: async (_taskId, record) => records.push(JSON.parse(JSON.stringify(record))) };
  const tool = createReportDoneTool({ verificationService: { ensurePassedArtifact }, reportService: {
    buildFinalReport: async (input) => input, saveReport: async (_id, report) => reports.push(report), writeReportFile: async () => {} } });
  const registry = checkpointedRegistry({ store, registry: { report_done: tool }, taskId: "T-WAIT", resumeState: state,
    selected: { agent_id: "CODER", provider, role: "coder" }, correlationId: "CORR-WAIT", projectLogger: (event) => events.push(event) });
  return { records, reports, events, began, state, run: (abortSignal) => registry.report_done.execute({ summary: "Implemented the requested behavior" },
    { execution_id: "EXEC", changed_paths: ["backend/src/a.js"], abortSignal, ticket: { id: "T-WAIT", acceptance_criteria: ["Lint passes"] } }),
  finish: () => Object.assign(job, { status: failed ? "failed" : "passed", error: failed ? { code: "VERIFY_COMMAND_FAILED", message: "lint failed" } : undefined }) };
}

for (const provider of ["codex", "claude"]) {
  test(`${provider}: one report call waits at its checkpoint then finishes without agent polling`, async () => {
    const f = fixture(provider);
    const result = f.run();
    await f.began;
    const checkpoint = f.records.at(-1);
    assert.equal(checkpoint.phase, "verification_wait");
    assert.equal(checkpoint.last_completed_turn, 12);
    assert.equal(checkpoint.verification_wait.report_draft.summary, "Implemented the requested behavior");
    assert.equal(checkpoint[provider === "codex" ? "thread_id" : "session_id"], provider === "codex" ? "THREAD" : "SESSION");
    assert.equal(f.reports.length, 0);
    f.finish();
    await result;
    assert.equal(f.reports.length, 1);
    assert.equal(f.records.at(-1).status, "completed");
    assert.equal(f.records.at(-1).verification_wait, null);
    assert.equal(f.state.turnCount, 13);
    assert.deepEqual(f.events.map((event) => event.event_name), ["ticket.verification_waiting", "ticket.verification_wait_finished"]);
    assert(!f.events.some((event) => event.status === "failed"));
  });
}

test("failed verification returns artifact and command evidence without a completion report", async () => {
  const f = fixture("codex", null, true);
  const result = f.run();
  await f.began;
  f.finish();
  await assert.rejects(result, (error) => error.code === "VERIFY_COMMAND_FAILED" && error.details.verification_diagnostic.commands[0].exit_code === 1);
  assert.equal(f.reports.length, 0);
  assert.equal(f.records.at(-1).verification_wait.status, "failed");
  assert.equal(f.records.at(-1).status, "in_progress");
  assert.equal(f.state.turnCount, 12);
});

test("Stop leaves the draft resumable without writing a successful report", async () => {
  const f = fixture("claude");
  const controller = new AbortController();
  const result = f.run(controller.signal);
  await f.began;
  controller.abort(Object.assign(new Error("Stopped"), { code: "TICKET_STOPPED" }));
  await assert.rejects(result, { code: "TICKET_STOPPED" });
  assert.equal(f.reports.length, 0);
  assert.equal(f.records.at(-1).verification_wait.status, "stopped");
});

test("restart checkpoint restores the draft and provider identity without replaying edits or commits", async () => {
  const f = fixture("codex");
  const controller = new AbortController();
  const result = f.run(controller.signal);
  await f.began;
  const persisted = JSON.parse(JSON.stringify(f.records.at(-1)));
  controller.abort(new Error("Process shutdown"));
  await assert.rejects(result, /Process shutdown/);
  const next = fixture("codex", persisted);
  const prompt = buildResumePrompt("Finish ticket", next.state);
  assert.match(prompt, /Node retained verification\/report checkpoint/);
  assert.match(prompt, /Implemented the requested behavior/);
  assert.equal(next.state.threadId, "THREAD");
  const resumed = next.run();
  await next.began;
  next.finish();
  await resumed;
  assert.deepEqual(next.state.completedTools, ["edit_diff", "commit_changes", "report_done"]);
  assert.equal(next.records.at(-1).last_completed_turn, 13);
});
