// Verifies that a rejected review resumes the Coder with findings in a fresh provider session.
import assert from "node:assert/strict";
import test from "node:test";
import { reviewPhaseResume, reviewRevisionResume } from "../../src/modules/supervisor/review-revision-resume.js";
import { buildResumePrompt, createResumeState } from "../../src/modules/supervisor/ticket-resume.js";

test("review revision recovery keeps findings and drops a completed Claude session", async () => {
  const checkpoint = { task_id: "T-1", status: "in_progress", agent_id: "coder-1", provider: "claude", session_id: "old-session", last_completed_turn: 41, changed_paths: ["ui/Dialog.jsx"] };
  const queueStore = { list: async () => [{ task_id: "T-1", attempt: 2, request_id: "REQ-T-1-REV-1", payload: { review_findings: ["Add focus behavior tests."], resume_from: { changed_paths: ["ui/Dialog.jsx", "ui/dialog.test.js"] } } }] };
  const resume = await reviewRevisionResume(queueStore, "T-1", checkpoint);
  assert.equal(resume.session_id, null);
  assert.equal(resume.last_completed_turn, 0);
  assert.deepEqual(resume.changed_paths, ["ui/Dialog.jsx", "ui/dialog.test.js"]);
  assert.match(buildResumePrompt("Implement ticket", createResumeState(resume)), /Add focus behavior tests/);
});

test("ordinary incomplete checkpoint remains unchanged without a review revision", async () => {
  const checkpoint = { task_id: "T-1", status: "in_progress", session_id: "keep-session" };
  assert.equal(await reviewRevisionResume({ list: async () => [] }, "T-1", checkpoint), checkpoint);
});

test("resume keeps progress already made in the same review revision", async () => {
  const findings = ["Add dialog tests."];
  const checkpoint = { task_id: "T-1", status: "in_progress", attempt: 3, last_completed_turn: 18, last_tool: "git_diff", review_findings: findings };
  const queueStore = { list: async () => [{ task_id: "T-1", attempt: 3, payload: { review_findings: findings } }] };
  assert.equal(await reviewRevisionResume(queueStore, "T-1", checkpoint), checkpoint);
});

test("completed Coder resumes failed review at the same review attempt", () => {
  const coder = { status: "completed", agent_id: "coder-1", provider: "codex", attempt: 3, changed_paths: ["ui/Dialog.jsx"] };
  const reviewer = { status: "failed", review_attempt: 2, attempt: 3, verification: { coder_summary: "Done", tool_events: [] } };
  assert.deepEqual(reviewPhaseResume(coder, reviewer), { agent_id: "coder-1", provider: "codex", changed_paths: ["ui/Dialog.jsx"], review_attempt: 2, base_commit: null, verification: reviewer.verification });
});

test("approved review cannot resume Coder or Reviewer", () => {
  assert.equal(reviewPhaseResume({ status: "completed", agent_id: "coder-1", provider: "codex" }, { verdict: "approved" }), null);
});

test("completed Coder revision advances to the next review attempt", () => {
  const resume = reviewPhaseResume({ status: "completed", agent_id: "coder-1", provider: "codex", attempt: 3, changed_paths: ["ui/Dialog.jsx"] }, { status: "completed", verdict: "request_changes", review_attempt: 1, attempt: 2 });
  assert.equal(resume.review_attempt, 2);
});
