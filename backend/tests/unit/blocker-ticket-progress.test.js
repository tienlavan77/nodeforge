// Verifies source-bound criterion progress and gap-focused recovery without replaying completed Coder work.
import assert from "node:assert/strict";
import test from "node:test";
import { buildBlockerTicketProgress, validateCriterionUpdates, recordCriterionUpdates } from "../../src/modules/supervisor/blocker-ticket-progress.js";
import { transitionCoderCandidate } from "../../src/modules/supervisor/blocker-coder-candidate.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { buildResumePrompt, createResumeState } from "../../src/modules/supervisor/ticket-resume.js";

// Supplies independent Node-owned writes and check receipts, with no attribution inferred from file names.
function progressFixture() {
  const file = { path: "backend/handler.js", sha256: `sha256:${"a".repeat(64)}` };
  const context = { source_revision: "REV", manifest_sha: "MANIFEST", review_commit_sha: "COMMIT" };
  const job = { id: "J", stage: "sprint_leader", history: [], request: { task_id: "T", payload: { execution_id: "EXEC" }, ticket: {
    acceptance_criteria: ["Handler routes the selected project", "Invalid project is rejected"],
    verification_plan: [{ kind: "test", criterion_ids: ["AC-1"], test_path: "handler.test.js" }, { kind: "test", criterion_ids: ["AC-2"], test_path: "reject.test.js" }]
  } } };
  const artifact = { artifact_id: "ARTIFACT-1", changed_paths: [file.path], commands: [{ kind: "test", argv: ["handler.test.js"], exit_code: 0 }] };
  const workspace = { executionContexts: { load: async () => context }, changeLedger: { snapshot: async () => ({ entries: { [file.path]: { latest_sha: file.sha256 } } }) },
    testService: { assertPassedArtifact: async () => artifact } };
  return { file, context, job, artifact, workspace, checkpoint: { last_completed_turn: 33, changed_paths: [file.path, "unrelated.css"] } };
}

test("Node separates changed files, attributed implementation and mapped check receipts", async () => {
  const f = progressFixture();
  let progress = await buildBlockerTicketProgress(f);
  assert.equal(progress.criteria[0].implementation, "unknown");
  assert.equal(progress.criteria[0].verification, "unverified");
  assert.deepEqual(progress.unassigned_changed_files, [f.file]);
  assert.equal(progress.changed_files.some((file) => file.path === "unrelated.css"), false);
  f.job.ticket_progress = progress;
  const value = { criterion_updates: [{ criterion_id: "AC-1", files: [f.file], remaining_work: "Run the mapped handler test." }] };
  validateCriterionUpdates(value, f.job);
  recordCriterionUpdates(f.job, value);
  progress = await buildBlockerTicketProgress(f);
  assert.equal(progress.criteria[0].implementation, "recorded");
  assert.equal(progress.criteria[0].verification, "unverified");
  f.context.verification_artifact_id = f.artifact.artifact_id;
  progress = await buildBlockerTicketProgress(f);
  assert.equal(progress.criteria[0].verification, "verified");
  assert.equal(progress.criteria[1].verification, "evidence_pending");
  assert.deepEqual(progress.pending_criterion_ids, ["AC-2"]);
  assert.equal(progress.last_completed_turn, 33);
});

test("progress hands Node journal observations to recovery and binds their identity without claiming verification", async () => {
  const f = progressFixture();
  const source = { status: "observed", parent_sha: "HEAD", sha256: "one", files: [] };
  f.workspace.gitService = { inspectSource: async (manifest) => {
    assert.equal(manifest.entries[f.file.path].latest_sha, f.file.sha256);
    return { ...source };
  } };
  const first = await buildBlockerTicketProgress(f);
  assert.deepEqual(first.source_reconciliation, source);
  source.sha256 = "two";
  assert.notEqual((await buildBlockerTicketProgress(f)).evidence_sha256, first.evidence_sha256);
  assert.equal(first.criteria[0].verification, "unverified");
});

test("Node invalidates implementation mapping and verification when source evidence drifts", async () => {
  const f = progressFixture();
  f.job.criterion_updates = [{ criterion_id: "AC-1", files: [f.file], remaining_work: "Verify routing" }];
  f.context.verification_artifact_id = "OLD";
  f.workspace.changeLedger.snapshot = async () => ({ entries: { [f.file.path]: { latest_sha: "sha256:new" } } });
  f.workspace.testService.assertPassedArtifact = async () => { throw Object.assign(new Error("Source changed"), { code: "VERIFY_ARTIFACT_MISMATCH" }); };
  const progress = await buildBlockerTicketProgress(f);
  assert.equal(progress.criteria[0].implementation, "stale");
  assert.equal(progress.criteria[0].verification, "unverified");
  assert.equal(progress.artifact_id, null);
  assert.equal(progress.diagnostics[0].code, "VERIFY_ARTIFACT_MISMATCH");
  f.workspace.changeLedger.snapshot = async () => { throw Object.assign(new Error("Unowned edit"), { code: "TICKET_SOURCE_CHANGED" }); };
  assert.deepEqual((await buildBlockerTicketProgress(f)).changed_files, []);
  f.workspace.changeLedger.snapshot = async () => { throw new Error("Database unavailable"); };
  await assert.rejects(buildBlockerTicketProgress(f), /Database unavailable/);
});

test("agent claims cannot invent criteria, unrelated file ownership, checksums or verified status", async () => {
  const f = progressFixture();
  f.job.ticket_progress = await buildBlockerTicketProgress(f);
  const good = { criterion_id: "AC-1", files: [f.file], remaining_work: "Check routing" };
  for (const update of [{ ...good, criterion_id: "AC-9" }, { ...good, files: [{ ...f.file, path: "unrelated.css" }] },
    { ...good, files: [{ ...f.file, sha256: "wrong" }] }, { ...good, status: "verified" }]) {
    assert.throws(() => validateCriterionUpdates({ criterion_updates: [update] }, f.job), { code: "BLOCKER_DISPOSITION_INVALID" });
  }
});

test("reworded requests on unchanged evidence go back to SL for a decision without relaunching Coder", async () => {
  const f = progressFixture();
  f.job.ticket_progress = await buildBlockerTicketProgress(f);
  const request = { action: "coder_requested", summary: "Clarify missing implementation", guidance: "Explain the routing gap",
    coder_request: { criterion_ids: ["AC-1"], questions: ["Which handler must change?"], constraints: ["Preserve the contract"] } };
  transitionCoderCandidate(f.job, request, 1);
  transitionCoderCandidate(f.job, { action: "architecture_required", summary: "Handler identified", guidance: "Implementation can resume" }, 2);
  transitionCoderCandidate(f.job, { ...request, guidance: "Different wording", coder_request: { ...request.coder_request, questions: ["Inspect the routing again?"] } }, 3);
  assert.equal(f.job.stage, "sprint_leader");
  assert.equal(f.job.status, "pending");
  assert.match(f.job.coordination_feedback, /SL must choose resolved/);
  transitionCoderCandidate(f.job, request, 4);
  assert.equal(f.job.status, "notification_pending");
  assert.equal(f.job.outcome_reason, "technical_reconciliation_no_progress");
});

test("new source evidence allows focused follow-up, while already verified criteria cannot be requested", async () => {
  const f = progressFixture();
  f.context.verification_artifact_id = "CURRENT";
  f.job.ticket_progress = await buildBlockerTicketProgress(f);
  const request = { action: "coder_requested", guidance: "Clarify the rejection gap", coder_request: {
    criterion_ids: ["AC-1"], questions: ["What is missing?"], constraints: ["Preserve routing"] } };
  assert.throws(() => transitionCoderCandidate(f.job, request, 1), { code: "BLOCKER_DISPOSITION_INVALID" });
  request.coder_request.criterion_ids = ["AC-2"];
  transitionCoderCandidate(f.job, request, 2);
  transitionCoderCandidate(f.job, { action: "architecture_required", summary: "No input", guidance: "Need rejection source" }, 3);
  f.context.source_revision = "NEW";
  f.job.ticket_progress = await buildBlockerTicketProgress(f);
  transitionCoderCandidate(f.job, request, 4);
  assert.equal(f.job.stage, "coder");
  assert.equal(f.job.status, "pending");
});

test("alternating criterion scopes across restart cannot hide a repeated unanswered request", async () => {
  const f = progressFixture();
  f.job.ticket_progress = await buildBlockerTicketProgress(f);
  const request = { action: "coder_requested", guidance: "Inspect the remaining gap", coder_request: {
    criterion_ids: ["AC-1"], questions: ["What input is missing?"], constraints: ["Preserve approved scope"] } };
  const feedback = { action: "architecture_required", summary: "No new candidate", guidance: "Enough design exists to resume implementation" };
  transitionCoderCandidate(f.job, request, 1);
  transitionCoderCandidate(f.job, feedback, 2);
  transitionCoderCandidate(f.job, { ...request, coder_request: { ...request.coder_request, criterion_ids: ["AC-2"] } }, 3);
  transitionCoderCandidate(f.job, feedback, 4);
  f.job = JSON.parse(JSON.stringify(f.job));
  transitionCoderCandidate(f.job, { ...request, guidance: "Reworded request for the original gap" }, 5);
  assert.equal(f.job.stage, "sprint_leader");
  assert.match(f.job.coordination_feedback, /No new implementation/);
});

test("a newly validated AM answer changes the evidence available for a focused Coder request", async () => {
  const f = progressFixture();
  f.job.ticket_progress = await buildBlockerTicketProgress(f);
  const request = { action: "coder_requested", guidance: "Explain how to preserve initialization", coder_request: {
    criterion_ids: ["AC-1"], questions: ["Which permitted change satisfies the gap?"], constraints: ["Preserve initialization"] } };
  transitionCoderCandidate(f.job, request, 1);
  transitionCoderCandidate(f.job, { action: "architecture_required", summary: "Design needed", guidance: "SL needs one Architecture answer" }, 2);
  f.job.architecture_response = { disposition: { action: "resolved", guidance: "Use an injected project-bound handler without moving initialization" } };
  f.job.ticket_progress = await buildBlockerTicketProgress(f);
  transitionCoderCandidate(f.job, request, 3);
  assert.equal(f.job.stage, "coder");
  assert.equal(f.job.coordination_feedback, undefined);
});

test("SL resumes normal Coder from retained progress without demanding an entire candidate dossier", async () => {
  const result = { findings: ["Existing handler contract is sufficient."], implementation_steps: ["Complete the remaining handler change."],
    verification_steps: ["Run the focused handler test."], admission: { status: "within_existing_permissions", rationale: "No denied operation is needed; existing gates remain enforced." } };
  const fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    assert.equal(job.ticket_progress.last_completed_turn, job.coder_checkpoint.last_completed_turn);
    assert.equal(job.ticket_progress.execution_id, "EXEC");
    if (job.stage === "coder") return { action: "architecture_required", summary: "Handler location identified", guidance: "Continue existing edits; no additional design is required." };
    return job.coder_exchange ? { ...resolution, technical_result: result } : { action: "coder_requested", summary: "One remaining question", guidance: "Identify the handler only",
      coder_request: { criterion_ids: ["AC-1"], questions: ["Locate the missing handler"], constraints: ["Do not repeat earlier work"] } };
  } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    const before = await fixture.base.checkpoints.load("TASK");
    await fixture.recovery.tick();
    assert.ok((await fixture.ledger()).jobs[0].ticket_progress);
    fixture.recreate();
    await fixture.recovery.tick();
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "resume_pending");
    assert.equal(fixture.base.invocations, 1);
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).execution_id, "EXEC");
    assert.equal(fixture.base.invocations, 2);
    assert.deepEqual(fixture.calls, ["sprint_leader", "coder", "sprint_leader"]);
    const after = await fixture.base.checkpoints.load("TASK");
    assert.equal(after.blocker_recovery.ticket_progress.last_completed_turn, before.last_completed_turn);
    assert.match(buildResumePrompt("Ticket", createResumeState({ ...after, status: "in_progress" })), /Retained criterion progress/);
  } finally { await fixture.close(); }
});

test("source conflicts expose retained Node evidence to SL without attributing unverified live bytes", async () => {
  const f = progressFixture();
  let reconciled = false;
  const receipt = { status: "conflict", live_sha: "live", conflicts: [{ base_start_line: 3 }] };
  f.workspace.changeLedger.reconcile = async () => { reconciled = true; };
  f.workspace.changeLedger.snapshot = async () => { throw Object.assign(new Error("Concurrent source"), { code: "TICKET_SOURCE_CHANGED" }); };
  f.workspace.changeLedger.load = async () => ({ entries: { [f.file.path]: { latest_sha: f.file.sha256, source_reconciliation: receipt } } });
  f.workspace.gitService = { inspectSource: async (manifest) => ({ files: [{ path: f.file.path, source_reconciliation: manifest.entries[f.file.path].source_reconciliation }] }) };
  const progress = await buildBlockerTicketProgress(f);
  assert.equal(reconciled, false);
  assert.deepEqual(progress.source_reconciliation.files[0].source_reconciliation, receipt);
  assert.deepEqual(progress.changed_files, []);
  assert.equal(progress.criteria[0].implementation, "unknown");
  assert.equal(progress.last_completed_turn, 33);
});
