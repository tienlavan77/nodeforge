// Verifies incomplete legacy reports resume Coder evidence collection instead of replaying completion.
import assert from "node:assert/strict";
import test from "node:test";
import { coderEvidenceResume } from "../../src/modules/supervisor/coder-evidence-resume.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";
import { buildResumePrompt, createResumeState } from "../../src/modules/supervisor/ticket-resume.js";
import { createTicketReviewFindingsStore } from "../../src/modules/supervisor/ticket-review-findings.js";

const checkpoint = { task_id: "TICKET-1", status: "completed", phase: "coder_reported", completed_at: "2026-10-13", agent_id: "CODER-1", provider: "codex", thread_id: "THREAD-1", last_completed_turn: 4, changed_paths: ["ui/page.jsx"], completed_tools: ["edit_diff", "commit_changes", "run_check", "report_done"], turn_history: [{ tool: "commit_changes" }, { tool: "report_done" }] };
const pendingReport = { status: "submitted_for_review", criteria_check: [{ criterion_id: "AC-10", status: "evidence_pending" }] };

test("pending report resumes Coder with changes and commit history intact", () => {
  const resume = coderEvidenceResume(checkpoint, pendingReport);
  assert.equal(resume.status, "in_progress");
  assert.equal(resume.phase, "coder_evidence_required");
  assert.equal(resume.thread_id, "THREAD-1");
  assert.deepEqual(resume.changed_paths, checkpoint.changed_paths);
  assert.deepEqual(resume.completed_tools, ["edit_diff", "commit_changes", "run_check"]);
  assert.deepEqual(resume.turn_history, [{ tool: "commit_changes" }]);
  assert.deepEqual(resume.pending_criterion_ids, ["AC-10"]);
  assert.equal(resume.completed_at, undefined);
  assert.equal(checkpoint.status, "completed");
  assert.match(buildResumePrompt("Fix ticket", createResumeState(resume)), /EVIDENCE RECOVERY.*AC-10/);
});

test("verified, approved and incomplete checkpoints retain their normal paths", () => {
  assert.equal(coderEvidenceResume(checkpoint, { status: "completed", criteria_check: [] }), null);
  assert.equal(coderEvidenceResume(checkpoint, { status: "submitted_for_review", criteria_check: [{ status: "verified" }] }), null);
  assert.equal(coderEvidenceResume({ ...checkpoint, status: "blocked" }, pendingReport), null);
  assert.equal(coderEvidenceResume({ ...checkpoint, status: "in_progress" }, pendingReport), null);
});

// Builds a dispatch without SQLite to verify checkpoint routing independently of runtime binaries.
function dispatchFixture({ reviewer = null, report = pendingReport, error = null } = {}) {
  const calls = [];
  const cleared = [];
  const ticket = { id: "TICKET-1", project_id: "PROJECT-1", sprint_id: "SPRINT-1", dependencies: [] };
  let current = { status: "failed", details: {}, version: 1 };
  const dispatch = createTicketRunDispatch({
    disposition: { get: async () => null }, intake: { open: async () => ({ ticket }) },
    sprintRegistry: { get: () => ({}), assertReady: async () => ({ plan: { content: { tickets: [ticket.id] } } }) },
    ticketStatusStore: { get: () => current, retry: () => { current = { ...current, status: "pending" }; return current; }, updateStatus: (_id, status) => { current = { ...current, status }; } },
    checkpoints: { load: async () => checkpoint, loadReview: async () => reviewer, clear: async () => { cleared.push("checkpoint"); } },
    protocolStorage: { get: async () => { if (error) throw error; return { data: report }; }, clearTask: async () => { cleared.push("report"); } },
    conversationStateStore: { clear: async () => { cleared.push("conversation"); } },
    dispatchTask: async (request) => { calls.push(request); return { status: "completed" }; }
  });
  return { run: (options = {}) => dispatch({ projectId: "PROJECT-1", ticketId: ticket.id, ...options }), calls, cleared };
}

test("RUN with legacy pending report dispatches Coder without clearing existing evidence", async () => {
  const fixture = dispatchFixture();
  assert.equal((await fixture.run()).resumed, true);
  assert.equal(fixture.calls[0].review_resume, undefined);
  assert.equal(fixture.calls[0].resume_from.phase, "coder_evidence_required");
  assert.deepEqual(fixture.cleared, []);
});

test("approved review still requires integration recovery and never reruns Coder", async () => {
  const fixture = dispatchFixture({ reviewer: { verdict: "approved" } });
  await assert.rejects(fixture.run(), { code: "TICKET_INTEGRATION_RECOVERY_REQUIRED" });
  assert.deepEqual(fixture.calls, []);
});

test("fresh RUN bypasses old report and ordinary verified report retains completion recovery", async () => {
  const fresh = dispatchFixture();
  await fresh.run({ fresh: true });
  assert.equal(fresh.calls[0].resume_from, undefined);
  assert.deepEqual(fresh.cleared, ["checkpoint", "report", "conversation"]);
  const verified = dispatchFixture({ report: { status: "submitted_for_review", criteria_check: [{ status: "verified" }] } });
  await verified.run();
  assert.ok(verified.calls[0].review_resume);
});

test("report corruption is not hidden by checkpoint recovery", async () => {
  const fixture = dispatchFixture({ error: Object.assign(new Error("corrupt report"), { code: "STORAGE_CHECKSUM_MISMATCH" }) });
  await assert.rejects(fixture.run(), { code: "STORAGE_CHECKSUM_MISMATCH" });
  assert.deepEqual(fixture.calls, []);
});

test("legacy immutable pending report becomes correctable draft with original audit retained", async () => {
  const artifact = { status: "passed", artifact_id: "ARTIFACT-1", commit_sha: "commit", source_revision: "source", manifest_sha: "manifest" };
  const original = { summary: "Original report", acceptance_coverage: [{ criterion_id: "AC-10", status: "evidence_pending" }] };
  const legacy = { ...artifact, review_commit_sha: artifact.commit_sha, report: original, idempotency_key: "ARTIFACT-1:report" };
  let record = { task_id: "TICKET-1", version: 1, coder_reports: [legacy], coder_report_drafts: [] };
  const store = createTicketReviewFindingsStore({ taskId: "TICKET-1", fileService: { createLock: async () => ({ release: async () => {} }), readFile: async () => JSON.stringify(record), atomicWrite: async ({ content }) => { record = JSON.parse(content); } }, executionContexts: { load: async () => ({ verification_artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha, source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha }) } });
  const corrected = { ...original, acceptance_coverage: [{ criterion_id: "AC-10", status: "verified", command_kind: "test" }] };
  await store.recordCoderReportDraft({ report: corrected, artifact });
  assert.equal(record.coder_reports.length, 0);
  assert.deepEqual(record.rejected_coder_reports[0].report, original);
  assert.deepEqual(record.coder_report_drafts[0].report, corrected);
  await store.recordCoderReport({ report: corrected, artifact, idempotencyKey: legacy.idempotency_key });
  assert.deepEqual(record.coder_reports[0].report, corrected);
  await assert.rejects(store.recordCoderReportDraft({ report: { ...corrected, summary: "Rewrite" }, artifact }), { code: "CODER_REPORT_CONFLICT" });
});
