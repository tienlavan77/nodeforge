// Ensures newly available retained review source wakes SL once without polling unchanged evidence forever.
import test from "node:test";
import assert from "node:assert/strict";
import { createBlockerReconciliationRefresh } from "../../src/modules/supervisor/blocker-reconciliation-refresh.js";
import { inspectReviewResponseReadiness } from "../../src/modules/supervisor/review-response-readiness.js";
import { requiresBlockerAdmission } from "../../src/modules/supervisor/blocker-failure-classification.js";

// Reopens a parked correction only when current complete receipts prove its old access classification obsolete.
test("report conflict classification wakes a parked invalid disposition once and preserves real denials", async () => {
  for (const denied of [false, true]) {
    const job = { id: "JOB", reason_code: "ACCESS_REQUIRED", failure_at: "2026-10-21T16:10:00Z",
      request: { task_id: "T", project_id: "P", payload: { execution_id: "EXEC" } },
      outcome_reason: "disposition_correction_no_progress", history: [], resolution: { summary: "Deliver retained responses" },
      validation_feedback: [{ reason: "access_or_security_authority_required" }],
      ticket_progress: { failure_classification: { category: "access_or_unknown" } } };
    const refresh = createBlockerReconciliationRefresh({ inspect: async () => ({ workspace: { projectRoot: "/project" } }),
      readFailureEvidence: async () => ({ status: "captured", receipts: [
        { tool: "report_done", error: { code: "CODER_REPORT_CONFLICT", message: "Immutable summary differs" } },
        ...(denied ? [{ tool: "edit_diff", error: { code: "APPROVAL_DENIED", message: "Approval denied" } }] : [])
      ] }) });
    assert.equal(await refresh(job), !denied);
    assert.equal(requiresBlockerAdmission(job), denied);
    if (!denied) {
      assert.equal(job.validation_feedback, undefined);
      assert.equal(job.history[0].previous_resolution.summary, "Deliver retained responses");
      assert.equal(await refresh(job), false);
    } else assert.equal(job.history.length, 0);
  }
});

test("new retained review evidence re-arms waiting SL once and preserves its prior disposition", async () => {
  const retained = { status: "available_for_unchanged_response", artifact_id: "ARTIFACT-1", commit_sha: "a".repeat(40) };
  const events = [];
  const refresh = createBlockerReconciliationRefresh({ inspect: async () => ({ workspace: { inspectFindingReviewSource: async () => retained } }),
    clock: () => 123, projectLogger: (event) => events.push(event) });
  const resolution = { summary: "Waiting for old source and complete history" };
  const job = { id: "JOB-1", request: { task_id: "TICKET-1" }, outcome_reason: "technical_reconciliation_waiting_for_evidence",
    history: [], resolution, ticket_progress: {}, validation_feedback: ["old evidence"] };
  assert.equal(await refresh(job), true);
  assert.deepEqual(job.history[0].previous_resolution, resolution);
  assert.deepEqual(job.ticket_progress.retained_review_source, retained);
  assert.equal(job.resolution, undefined);
  assert.equal(job.validation_feedback, undefined);
  assert.equal(await refresh(job), false);
  assert.equal(events.length, 1);
});

test("unavailable or unchanged recovery does not wake a waiting agent", async () => {
  const refresh = createBlockerReconciliationRefresh({ inspect: async () => ({ workspace: { inspectFindingReviewSource: async () => null } }) });
  assert.equal(await refresh({ outcome_reason: "technical_reconciliation_waiting_for_evidence", history: [] }), false);
});

// Models the actual second blocker: source is already restored, but its response tool was previously hidden.
test("exposed response delivery wakes SL once on the existing artifact without editing its report", async () => {
  const artifact = { artifact_id: "ARTIFACT-1", commit_sha: "a".repeat(40), source_revision: "sha256:s", manifest_sha: "sha256:m" };
  const report = { artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha, source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha, idempotency_key: "REPORT-1" };
  const workspace = { toolRegistry: { respond_to_review: { execute: async () => {} } },
    executionContexts: { load: async () => ({ state: "reviewing", verification_artifact_id: artifact.artifact_id }) },
    testService: { assertPassedArtifact: async () => artifact }, reviewFindings: { load: async () => ({ coder_reports: [report] }) } };
  const before = structuredClone(report);
  assert.equal((await inspectReviewResponseReadiness(workspace, "TICKET-1")).status, "available");
  const refresh = createBlockerReconciliationRefresh({ inspect: async () => ({ workspace }) });
  const job = { id: "JOB", request: { task_id: "TICKET-1" }, outcome_reason: "technical_reconciliation_waiting_for_evidence", history: [], ticket_progress: {} };
  assert.equal(await refresh(job), true);
  assert.equal(job.history[0].event, "review_response_delivery_available");
  assert.equal(await refresh(job), false);
  assert.deepEqual(report, before);
  report.source_revision = "stale";
  assert.equal(await inspectReviewResponseReadiness(workspace, "TICKET-1"), null);
  delete workspace.toolRegistry.respond_to_review;
  assert.equal(await inspectReviewResponseReadiness(workspace, "TICKET-1"), null);
});
