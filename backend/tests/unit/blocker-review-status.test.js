/** Covers technical recovery both before initial Review and inside finding
 * repair, including missing checkpoints and durable historical evidence.
 * The evidence projection must retain REV/cycle identities across restart and
 * compact prompts without changing acceptance, permissions or review records. */
import assert from "node:assert/strict";
import test from "node:test";
import { blockerReviewStatus } from "../../src/modules/supervisor/blocker-review-status.js";
import { buildBlockerTicketProgress } from "../../src/modules/supervisor/blocker-ticket-progress.js";
import { createBlockerPromptContext } from "../../src/modules/supervisor/blocker-prompt-context.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

/** Supplies explicitly loaded empty review stores and an existing Coder
 * checkpoint so absent evidence differs from an unavailable evidence reader. */
function input() {
  return { job: { request: { task_id: "TASK", project_id: "P", payload: {} } }, checkpoint: { last_completed_turn: 118 },
    context: { task_id: "TASK", project_id: "P", state: "coding" },
    reviewCheckpoint: null, reviewExchange: { task_id: "TASK", findings: [], adjudications: [] } };
}

test("not_started requires available empty review evidence; unavailable stores remain unknown", () => {
  const fresh = input();
  assert.equal(blockerReviewStatus(fresh).status, "not_started");
  assert.equal(blockerReviewStatus(fresh).report_status, "not_created");
  for (const field of ["reviewCheckpoint", "reviewExchange"]) {
    const missing = { ...input(), [field]: undefined };
    const result = blockerReviewStatus(missing);
    assert.equal(result.status, "unknown", field);
    assert.equal(result.report_status, "unknown", field);
    assert(result.unavailable_sources.length);
  }
});

test("persisted open findings preserve repair identity when the Reviewer checkpoint is missing", () => {
  const current = input();
  current.reviewExchange.findings.push({ finding_id: "REV-3", status: "open", artifact_id: "ARTIFACT-OLD", review_commit_sha: "COMMIT-OLD" });
  const before = structuredClone(current), result = blockerReviewStatus(current);
  assert.equal(result.status, "finding_repair");
  assert.equal(result.phase, "finding_repair");
  assert.equal(result.report_status, "recorded");
  assert.deepEqual(result.finding_ids, ["REV-3"]);
  assert.deepEqual(current, before, "Describing evidence cannot mutate findings or checkpoint");
});

test("repair cycles, assigned findings and legacy repair phases cannot be relabeled as initial Review", () => {
  for (const marker of ["cycle", "context_cycle", "source_cycle", "resumed_cycle", "retained_source", "assigned", "request_findings", "repair_key", "phase"]) {
    const current = input();
    if (marker === "cycle") current.checkpoint.review_cycle_id = "CYCLE";
    if (marker === "context_cycle") current.context.review_repair_cycle_id = "CYCLE";
    if (marker === "source_cycle") current.context.source_repair_cycle_id = "CYCLE";
    if (marker === "resumed_cycle") current.context.resumed_finding_cycle_id = "CYCLE";
    if (marker === "retained_source") current.retainedReviewSource = { status: "available_for_unchanged_response", cycle_id: "CYCLE" };
    if (marker === "assigned") current.checkpoint.review_findings = [{ finding_id: "REV-2" }];
    if (marker === "request_findings") current.job.request.payload.review_findings = [{ finding_id: "REV-2" }];
    if (marker === "repair_key") current.checkpoint.review_repair_key = "REPAIR";
    if (marker === "phase") current.checkpoint.phase = "finding_repair_ready";
    const result = blockerReviewStatus(current);
    assert.equal(result.status, "finding_repair", marker);
    assert.equal(result.report_status, "unknown", "Repair markers cannot fabricate a report");
    if (["cycle", "context_cycle", "source_cycle", "resumed_cycle", "retained_source"].includes(marker)) assert.equal(result.cycle_id, "CYCLE");
  }
});

test("earlier Reviewer progress and closed findings remain recorded even without a current report", () => {
  for (const marker of ["stage_history", "review_stage", "adjudication", "closed_finding"]) {
    const current = input();
    if (marker === "stage_history") current.checkpoint.stage_progress = [{ stage: "reviewer", status: "completed" }];
    if (marker === "review_stage") current.checkpoint.review_stage = { status: "completed" };
    if (marker === "adjudication") current.reviewExchange.adjudications = [{ finding_id: "REV-1", decision: "fixed" }];
    if (marker === "closed_finding") current.reviewExchange.findings = [{ finding_id: "REV-1", status: "fixed" }];
    const result = blockerReviewStatus(current);
    assert.equal(result.status, "recorded", marker);
    assert.notEqual(result.report_status, "not_created", marker);
  }
});

test("technical recovery preserves request_changes, while a new Reviewer invocation remains in progress", () => {
  const current = input();
  current.checkpoint.review_cycle_id = "CYCLE";
  current.checkpoint.review_findings = [{ finding_id: "REV-1", status: "open" }];
  current.reviewCheckpoint = { task_id: "TASK", status: "completed", verdict: "request_changes", findings: [{ finding_id: "REV-2" }] };
  assert.equal(blockerReviewStatus(current).status, "finding_repair");
  assert.equal(blockerReviewStatus(current).verdict, "request_changes");
  assert.deepEqual(blockerReviewStatus(current).finding_ids, ["REV-1", "REV-2"]);
  current.reviewCheckpoint = { task_id: "TASK", status: "in_progress", verdict: null };
  const reviewing = blockerReviewStatus(current);
  assert.equal(reviewing.status, "in_progress");
  assert.equal(reviewing.phase, "review");
  assert.equal(reviewing.cycle_id, "CYCLE");
  assert.deepEqual(reviewing.finding_ids, ["REV-1"]);
});

test("an actual completed approval is retained, without upgrading current source acceptance", () => {
  const current = input();
  current.reviewCheckpoint = { task_id: "TASK", status: "completed", verdict: "approved" };
  const result = blockerReviewStatus(current);
  assert.equal(result.status, "completed");
  assert.equal(result.verdict, "approved");
  assert.equal(result.ready_for_review, undefined);
  assert.equal(result.accepted, undefined);
});

test("foreign review identities are unavailable evidence and Coder reports alone do not prove Review occurred", () => {
  for (const record of [{ task_id: "OTHER", status: "completed", verdict: "approved" },
    { task_id: "TASK", project_id: "OTHER", status: "completed" },
    { execution_context: { task_id: "OTHER", project_id: "P" }, status: "completed" }]) {
    const result = blockerReviewStatus({ ...input(), reviewCheckpoint: record });
    assert.equal(result.status, "unknown");
    assert.equal(result.verdict, null);
  }
  assert.equal(blockerReviewStatus({ ...input(), reviewExchange: { task_id: "OTHER", findings: [{ finding_id: "REV-1", status: "open" }] } }).status, "unknown");
  const coderOnly = input();
  coderOnly.reviewExchange.coder_reports = [{ artifact_id: "ARTIFACT-1" }];
  assert.equal(blockerReviewStatus(coderOnly).status, "not_started");
});

test("restart and both compact prompt forms preserve missing-checkpoint finding repair and the Coder turn", async (t) => {
  const f = await blockerRecoveryFixture();
  t.after(f.close);
  await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
  const saved = await f.base.checkpoints.load("TASK");
  await f.base.checkpoints.save({ ...saved, review_cycle_id: "CYCLE", review_findings: [{ finding_id: "REV-3", status: "open" }] });
  const checkpoint = await f.base.checkpoints.load("TASK"), job = (await f.ledger()).jobs[0];
  const history = { task_id: "TASK", findings: [{ finding_id: "REV-3", status: "open", artifact_id: "ARTIFACT-OLD" }], adjudications: [] };
  const workspace = { ...f.base.workspace, reviewFindings: { load: async () => history } };
  const before = JSON.stringify({ history, checkpoint });
  const progress = await buildBlockerTicketProgress({ job, checkpoint, workspace, reviewCheckpoint: null });
  assert.equal(progress.review_status.status, "finding_repair");
  assert.equal(progress.last_completed_turn, checkpoint.last_completed_turn);
  assert.equal(progress.review_findings[0].finding_id, "REV-3");
  const prepared = await createBlockerPromptContext({ job: { ...job, ticket_progress: progress }, projectRoot: workspace.projectRoot });
  for (const promptJob of [prepared.job, prepared.minimalJob]) {
    assert.equal(promptJob.ticket_progress.review_status.status, "finding_repair");
    assert.equal(promptJob.ticket_progress.review_status.cycle_id, "CYCLE");
    assert.deepEqual(promptJob.ticket_progress.review_status.finding_ids, ["REV-3"]);
  }
  assert.match(prepared.summary, /"status":"finding_repair"/);
  assert.equal(JSON.stringify({ history, checkpoint }), before);
  assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, checkpoint.last_completed_turn);
  workspace.reviewFindings.load = async () => { throw new Error("Review storage is unavailable"); };
  await assert.rejects(buildBlockerTicketProgress({ job, checkpoint, workspace, reviewCheckpoint: null }), /Review storage is unavailable/);
});
