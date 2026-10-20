// Exercises AM requests, read-only Coder proposals and exact-candidate technical review inside one recovery job.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";
import { transitionCoderCandidate } from "../../src/modules/supervisor/blocker-coder-candidate.js";
import { buildResumePrompt, createResumeState } from "../../src/modules/supervisor/ticket-resume.js";

const request = { action: "coder_requested", summary: "Coder must supply an initialization-preserving alternative.",
  guidance: "Preserve initialization and explain a narrowly scoped handler change.",
  coder_request: { questions: ["Show the exact proposed patch and focused verification."], constraints: ["Preserve initialization; do not repeat denied relocations."] } };

// Proposes a patch without applying it to the ticket workspace.
function prepared(fixture, suffix = "") {
  return { action: "candidate_prepared", summary: "Proposed a handler-only change.", candidate: { changes: [{
    path: fixture.evidence.path, sha256: fixture.evidence.sha256, rationale: "Keep the existing handler initialization.",
    patch: `--- a/${fixture.evidence.path}\n+++ b/${fixture.evidence.path}\n@@ -1 +1,2 @@\n export const approvedHandler = true;\n+export const selected${suffix} = true;\n`
  }], verification_steps: ["Run the focused handler routing test."] } };
}

// Returns a technical approval without fabricating an execution-tool gate result.
function approved(job, resolution) {
  return { ...resolution, candidate_review: { candidate_sha256: job.coder_exchange.candidate.sha256, verdict: "approved", comments: ["Initialization is preserved."] },
    technical_result: { findings: ["The concrete candidate preserves existing boundaries."], implementation_steps: ["Implement the reviewed handler proposal."],
      verification_steps: ["Run the focused handler test."], admission: { status: "within_existing_permissions", rationale: "The design avoids the denied operation; runtime gates still execute." } } };
}

// Reserves one serial recovery operation at a time to exercise durable stage transitions.
async function ticks(fixture, count) { for (let i = 0; i < count; i += 1) await fixture.recovery.tick(); }

test("Node obtains Coder's dossier before SL review, preserving the original checkpoint until approved resume", async () => {
  let fixture;
  fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    if (job.stage === "coder") {
      assert.equal(job.coder_exchange.request.questions[0], request.coder_request.questions[0]);
      assert.equal(job.coder_checkpoint.last_completed_turn, (await fixture.base.checkpoints.load("TASK")).last_completed_turn);
      return prepared(fixture);
    }
    return job.coder_exchange?.candidate ? approved(job, resolution) : request;
  } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    const original = await fixture.base.checkpoints.load("TASK");
    await ticks(fixture, 1);
    const before = await fixture.ledger();
    assert.equal(before.jobs[0].stage, "coder");
    assert.equal(fixture.base.invocations, 1);
    fixture.recreate();
    await ticks(fixture, 1);
    let ledger = await fixture.ledger();
    assert.equal(ledger.jobs[0].stage, "sprint_leader");
    assert.equal(ledger.jobs[0].status, "pending");
    assert.equal((await fixture.base.checkpoints.load("TASK")).failure.at, original.failure.at);
    assert.equal(await fixture.base.fileService.readFile({ path: fixture.evidence.path }), "export const approvedHandler = true;\n");
    assert.equal(fixture.base.invocations, 1);
    await ticks(fixture, 1);
    assert.equal((await fixture.ledger()).jobs[0].status, "resume_pending");
    await ticks(fixture, 1);
    ledger = await fixture.ledger();
    assert.equal(ledger.jobs.length, 1);
    assert.equal(ledger.execution_id, before.execution_id);
    assert.equal(ledger.deadline_at, before.deadline_at);
    assert.equal(ledger.jobs[0].status, "resumed");
    assert.deepEqual(fixture.calls, ["sprint_leader", "coder", "sprint_leader"]);
    assert.equal(fixture.base.integrations, 1);
    const checkpoint = await fixture.base.checkpoints.load("TASK");
    assert.equal(checkpoint.blocker_recovery.coder_exchange.candidate.sha256, ledger.jobs[0].coder_exchange.candidate.sha256);
    assert.match(buildResumePrompt("Ticket", createResumeState({ ...checkpoint, status: "in_progress", phase: "blocker_resolved" })), /Approved Coder candidate dossier \(review role: sprint_leader\)/);
  } finally { await fixture.close(); }
});

test("SL changes_requested goes back to Coder and reviews the new exact candidate", async () => {
  let fixture;
  let candidates = 0;
  fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    if (job.stage === "coder") return prepared(fixture, String(++candidates));
    if (!job.coder_exchange) return request;
    if (candidates === 1) return { ...request, coder_request: { ...request.coder_request, questions: ["Narrow the proposal to selected routing only."] },
      candidate_review: { candidate_sha256: job.coder_exchange.candidate.sha256, verdict: "changes_requested", comments: ["Narrow the patch."] } };
    return approved(job, resolution);
  } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await ticks(fixture, 7);
    assert.equal(candidates, 2);
    assert.equal((await fixture.ledger()).jobs[0].status, "resumed");
    assert.equal(fixture.base.integrations, 1);
    assert.deepEqual(fixture.calls, ["sprint_leader", "coder", "sprint_leader", "coder", "sprint_leader"]);
  } finally { await fixture.close(); }
});

test("candidate responses cannot impersonate SL, approval must match the dossier and stale source cannot resume", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const job = { id: "JOB", stage: "sprint_leader", request: { ticket: fixture.ticket, payload: { execution_id: "EXEC" } }, history: [] };
    const options = { job, plan: {}, fileService: fixture.base.fileService, projectRoot: fixture.base.workspace.projectRoot };
    transitionCoderCandidate(job, request, 1);
    await assert.rejects(validateBlockerDisposition(fixture.resolution, options), { code: "BLOCKER_DISPOSITION_INVALID" });
    await assert.rejects(validateBlockerDisposition({ ...request }, options), { code: "BLOCKER_DISPOSITION_INVALID" });
    const proposed = await validateBlockerDisposition(prepared(fixture), options);
    transitionCoderCandidate(job, proposed, 2);
    const decision = approved(job, fixture.resolution);
    const candidate = job.coder_exchange.candidate;
    assert.match(candidate.sha256, /^[a-f0-9]{64}$/);
    assert.equal((await validateBlockerDisposition(decision, options)).action, "resolved");
    for (const review of [undefined, { ...decision.candidate_review, candidate_sha256: "0".repeat(64) }, { ...decision.candidate_review, verdict: "changes_requested" }]) {
      await assert.rejects(validateBlockerDisposition({ ...decision, candidate_review: review }, options), { code: "BLOCKER_DISPOSITION_INVALID" });
    }
    for (const status of ["denied", "unresolved"]) {
      await assert.rejects(validateBlockerDisposition({ ...decision, technical_result: { ...decision.technical_result,
        admission: { ...decision.technical_result.admission, status } } }, options), { code: "BLOCKER_DISPOSITION_INVALID" });
    }
    await fixture.base.fileService.atomicWrite({ path: fixture.evidence.path, content: "changed meanwhile\n", replace: true });
    await assert.rejects(validateBlockerDisposition(decision, options), (error) => error.validation_errors[0].reason === "candidate_source_stale");
  } finally { await fixture.close(); }
});

for (const boundary of ["stop", "deadline", "source"]) {
  test(`Coder preparation respects ${boundary} without dispatching normal execution`, async () => {
    const fixture = await blockerRecoveryFixture({ investigate: async () => request });
    try {
      await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
      await ticks(fixture, 1);
      assert.equal((await fixture.ledger()).jobs[0].stage, "coder");
      if (boundary === "stop") await fixture.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
      if (boundary === "deadline") fixture.advance(600_001);
      if (boundary === "source") fixture.base.staleSource();
      await ticks(fixture, 1);
      assert.deepEqual(fixture.calls, ["sprint_leader"]);
      assert.equal(fixture.base.invocations, 1);
      assert.equal(fixture.base.integrations, 0);
      if (boundary === "stop") {
        const resumed = await fixture.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
        assert.equal(resumed.resumed_stage, "coder");
        assert.equal((await fixture.ledger()).jobs[0].coder_exchange.request.questions[0], request.coder_request.questions[0]);
      }
    } finally { await fixture.close(); }
  });
}


test("Coder can report missing safe input to SL and repeated identical requests stop without an execution launch", async () => {
  const fixture = await blockerRecoveryFixture({ investigate: async (job) => {
    if (job.stage === "coder") return { action: "architecture_required", summary: "No safe concrete patch can be prepared from these instructions.", guidance: "Specify an alternative that preserves initialization rather than moving it." };
    return request;
  } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await ticks(fixture, 6);
    const job = (await fixture.ledger()).jobs[0];
    assert.deepEqual(fixture.calls, ["sprint_leader", "coder", "sprint_leader", "sprint_leader"]);
    assert.equal(job.outcome_reason, "technical_reconciliation_no_progress");
    assert.equal(job.status, "reconciliation_required");
    assert.equal(fixture.base.invocations, 1);
  } finally { await fixture.close(); }
});


test("source drift after SL approval prevents normal Coder dispatch", async () => {
  let fixture;
  fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    if (job.stage === "coder") return prepared(fixture);
    return job.coder_exchange?.candidate ? approved(job, resolution) : request;
  } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await ticks(fixture, 3);
    assert.equal((await fixture.ledger()).jobs[0].status, "resume_pending");
    await fixture.base.fileService.atomicWrite({ path: fixture.evidence.path, content: "concurrent source change\n", replace: true });
    await ticks(fixture, 1);
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.base.integrations, 0);
    assert.equal((await fixture.ledger()).jobs[0].validation_feedback[0].reason, "candidate_source_stale");
  } finally { await fixture.close(); }
});
