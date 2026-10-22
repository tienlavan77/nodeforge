// Prevents accepted implementation findings from cycling through unchanged Coder responses and independent review.
import assert from "node:assert/strict";
import test from "node:test";
import { inspectReviewRepairProgress } from "../../src/modules/supervisor/review-repair-progress.js";
import { reviewRepairRecovery } from "../../src/modules/supervisor/review-repair-handoff.js";
import { buildResumePrompt, createResumeState } from "../../src/modules/supervisor/ticket-resume.js";
import { completeCoderTicket } from "../../src/modules/supervisor/ticket-coder-completion.js";

// Models a verified implementation finding and its unchanged accepted response without accepting agent claims as progress.
function fixture() {
  const artifact = { artifact_id: "ART", commit_sha: "COMMIT", source_revision: "SOURCE", manifest_sha: "MANIFEST" };
  const finding = { finding_id: "REV-1", finding: { files: ["source.js"], minimum_change_scope: "Repair statement boundaries" } };
  const response = { ...artifact, review_commit_sha: artifact.commit_sha, responses: [{ finding_id: "REV-1", position: "accept" }] };
  const history = { coder_responses: [response] };
  const workspace = { testService: { assertPassedArtifact: async () => artifact }, reportService: { assertCoderReport: async () => {} },
    reviewFindings: { load: async () => history, unresolved: async () => [finding] }, changeLedger: { release: async () => {} },
    executionContexts: { load: async () => ({}) } };
  const result = { tool_events: [{ tool: "respond_to_review", status: "success" }] };
  return { artifact, finding, response, history, workspace, result };
}

test("legacy repair prompts supersede obsolete delivery guidance while preserving denial evidence", () => {
  const blocker = { status: "resolved", disposition: { guidance: "OLD DELIVERY ONLY", technical_result: { implementation_steps: ["OLD NO EDIT"] } },
    ticket_progress: { old: "OLD EXTERNAL PREREQUISITE" }, execution_admission: { original: "retained" } };
  const snapshot = structuredClone(blocker);
  const recovery = reviewRepairRecovery(blocker, "REVIEW");
  assert.equal(recovery.status, "superseded_by_review");
  assert.deepEqual(recovery.execution_admission, blocker.execution_admission);
  const state = createResumeState({ status: "failed", review_repair_key: "REVIEW", review_findings: [{ finding_id: "REV-1" }], blocker_recovery: blocker });
  const prompt = buildResumePrompt("Repair this ticket", state);
  assert.match(prompt, /implement its minimum_change_scope/);
  assert.doesNotMatch(prompt, /OLD DELIVERY ONLY|OLD NO EDIT|OLD EXTERNAL PREREQUISITE/);
  assert.deepEqual(blocker, snapshot);
});

test("new response IDs do not count as repair; disputes, evidence-only findings and new source remain reviewable", async () => {
  const f = fixture();
  const options = { workspace: f.workspace, artifact: { ...f.artifact }, findings: [f.finding], result: f.result };
  const first = await inspectReviewRepairProgress(options);
  assert(first);
  f.response.idempotency_key = "ANOTHER";
  assert.equal((await inspectReviewRepairProgress(options)).signature, first.signature);
  f.response.responses[0].position = "dispute";
  assert.equal(await inspectReviewRepairProgress(options), null);
  f.response.responses[0].position = "accept";
  f.finding.finding.files = [];
  assert.equal(await inspectReviewRepairProgress(options), null);
  f.finding.finding.files = ["source.js"];
  f.artifact.commit_sha = "REPAIRED";
  assert.equal(await inspectReviewRepairProgress(options), null);
});

test("unchanged accepted findings return directly to Coder and never rerun Reviewer or integrate", async () => {
  const f = fixture();
  let reviews = 0, repairs = 0;
  const events = [];
  let checkpoint = { status: "completed", last_completed_turn: 12, thread_id: "THREAD" };
  const job = { job_key: "REVIEW", review_policy: { gate: "on" } };
  const automaticReview = { prepare: async () => job, process: async () => { reviews++; return { payload: { verdict: "request_changes", job_key: "REVIEW" } }; },
    consumeRepair: async () => true };
  const result = await completeCoderTicket({ ...f, taskId: "T", ownerId: "SUP", claim: { claim_id: "CLAIM" },
    request: { ticket: { execution_policy: { review_gate: "on" } } }, automaticReview,
    checkpoints: { load: async () => checkpoint, save: async (value) => { checkpoint = value; } },
    agentOccupancy: { release: async () => {} }, publishTicketOutcome: async (type, _request, _owner, payload) => events.push({ type, payload }),
    runRepair: async ({ request, outcome }) => {
      repairs++;
      if (repairs === 2) assert.match(outcome.payload.repair_implementation_required.instruction, /Continue implementation now/);
      return { request, result: f.result };
    } });
  assert.equal(reviews, 1);
  assert.equal(repairs, 2);
  assert.equal(result.reason, "REVIEW_REPAIR_NO_PROGRESS");
  assert.equal(checkpoint.status, "failed");
  assert.equal(checkpoint.last_completed_turn, 12);
  assert.equal(checkpoint.thread_id, "THREAD");
  assert.deepEqual(events.map((event) => event.type), ["task.failed"]);
  assert.equal(events[0].payload.retryable, true);
});
