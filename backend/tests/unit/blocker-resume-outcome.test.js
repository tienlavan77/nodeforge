/** Reproduces consumed Coder assignments being replayed after a scope blocker.
 * Real recovery/checkpoint integration proves the old assignment ends once,
 * while SL receives the new failure and cannot resend an unchanged handoff. */
import assert from "node:assert/strict";
import test from "node:test";
import { completeBlockedResume, previousBlockedHandoff, restoreBlockedHandoff, assertBlockerHandoffProgress } from "../../src/modules/supervisor/blocker/blocker-resume-outcome.js";
import { blockerRolePrompt } from "../../src/modules/supervisor/blocker/blocker-role-prompt.js";
import { createBlockerPromptContext } from "../../src/modules/supervisor/blocker/blocker-prompt-context.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

// Supplies two attempts with one source identity to distinguish consumed work
// from provider failures, agent occupancy and genuinely changed source.
function handoff() {
  return { id: "OLD", stage: "sprint_leader", status: "dispatching", failure_at: "before", reason_code: "SCOPE_CONFLICT", history: [],
    request: { execution_context: { source_revision: "SOURCE" } },
    resolution: { action: "resolved", summary: "Coordinate dependency repair.", guidance: "Wait for the frontend ticket before resuming.",
      evidence: [{ path: "ui/source.js", sha256: "a".repeat(64) }] } };
}

test("a returned Coder blocker consumes its handoff while busy and unknown outcomes stay separate", () => {
  for (const operation of ["resume_pending", "approval_retry_pending"]) {
    const job = handoff();
    const error = Object.assign(new Error("Original Coder blocker"), { code: "CODER_BLOCKED", details: { blocker: { reason_code: "SCOPE_CONFLICT" } } });
    assert.equal(completeBlockedResume(job, error, operation, 1000), true);
    assert.equal(job.status, "resumed");
    assert.equal(job.resume_outcome.reason_code, "SCOPE_CONFLICT");
    assert.equal(job.resume_outcome.message, error.message);
    assert.equal(job.history.at(-1).event, "resumed_coder_blocked");
  }
  for (const code of ["AGENT_NOT_AVAILABLE", "BLOCKER_PROVIDER_UNKNOWN", "FILE_ROLE_FORBIDDEN"]) {
    const job = handoff(), before = structuredClone(job);
    assert.equal(completeBlockedResume(job, { code }, "resume_pending", 1000), false);
    assert.deepEqual(job, before);
  }
  assert.equal(completeBlockedResume(handoff(), { code: "CODER_BLOCKED" }, "pending", 1000), false);
});

test("repeated scope handoffs require a changed instruction or explicit reconciliation", () => {
  const prior = handoff();
  const job = { ...prior, failure_at: "after" };
  job.previous_handoff = previousBlockedHandoff({ jobs: [prior] }, job);
  assert.equal(job.previous_handoff.job_id, "OLD");
  const decision = { ...prior.resolution, summary: "Same decision, rewritten summary." };
  assert.throws(() => assertBlockerHandoffProgress(decision, job), error => error.code === "BLOCKER_DISPOSITION_INVALID"
    && error.validation_errors[0].reason === "blocked_handoff_unchanged" && error.retryable_disposition);
  assert.doesNotThrow(() => assertBlockerHandoffProgress({ ...decision, guidance: "Implement the remaining backend-only fixture within the current ticket." }, job));
  assert.doesNotThrow(() => assertBlockerHandoffProgress({ action: "reconciliation_required" }, job));
  assert.doesNotThrow(() => assertBlockerHandoffProgress(decision, { ...job, stage: "architecture_manager" }));
  const changed = { ...job, request: { execution_context: { source_revision: "NEW" } } };
  assert.equal(previousBlockedHandoff({ jobs: [prior] }, changed), null);
  assert.equal(previousBlockedHandoff({ jobs: [{ ...prior, status: "resume_pending" }] }, job), null);
});

test("legacy failed handoffs resume at SL and retain exact prior instructions without accepting them again", () => {
  const job = { ...handoff(), status: "reconciliation_required", validation_feedback: [{ reason: "CODER_BLOCKED" }] };
  const decision = structuredClone(job.resolution);
  restoreBlockedHandoff(job, { jobs: [job] }, 1000);
  assert.equal(job.stage, "sprint_leader");
  assert.equal(job.resolution, undefined);
  assert.deepEqual(job.previous_handoff.disposition, decision);
  assert.match(blockerRolePrompt(job), /PREVIOUS CODER HANDOFF DID NOT CLEAR/);
  assert.match(blockerRolePrompt(job), /dependency_requested/);
});

test("a resumed Coder scope failure preserves its new checkpoint and cannot replay the old job after restart", async () => {
  const fixture = await blockerRecoveryFixture({ repeatBlock: true, investigate: async (job, resolution) => job.previous_handoff
    ? { ...job.previous_handoff.disposition, summary: "Repeat settled coordination." } : resolution });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "resume_pending");
    await fixture.recovery.tick();
    const ledger = await fixture.ledger();
    assert.equal(fixture.base.invocations, 2);
    assert.equal(ledger.jobs[0].status, "resumed");
    assert.equal(ledger.jobs[0].resume_outcome.code, "CODER_BLOCKED");
    assert.equal(ledger.jobs.length, 2);
    assert.equal(ledger.jobs[1].previous_handoff.job_id, ledger.jobs[0].id);
    const checkpoint = await fixture.base.checkpoints.load("TASK");
    assert.equal(checkpoint.blocker_recovery.job_id, ledger.jobs[1].id);
    assert.equal(checkpoint.failure.code, "CODER_BLOCKED");
    fixture.recreate();
    for (let count = 0; count < 5; count += 1) await fixture.recovery.tick();
    const stopped = await fixture.ledger();
    assert.equal(fixture.base.invocations, 2);
    assert.equal(stopped.jobs[0].status, "resumed");
    assert.equal(stopped.jobs[1].outcome_reason, "disposition_correction_no_progress");
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

test("full previous handoffs remain readable when blocker prompts are compacted", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const job = { ...handoff(), request: { project_id: "P", task_id: "TASK", ticket: fixture.ticket, payload: { execution_id: "E" } },
      previous_handoff: { job_id: "OLD", reason_code: "SCOPE_CONFLICT", disposition: handoff().resolution } };
    const prompt = await createBlockerPromptContext({ job, projectRoot: fixture.base.workspace.projectRoot });
    assert.ok(prompt.refs.some((entry) => entry.section === "previous_handoff"));
    assert.equal(prompt.minimalJob.previous_handoff.full_definition_section, "previous_handoff");
    assert.equal(prompt.minimalJob.previous_handoff.job_id, "OLD");
  } finally { await fixture.close(); }
});
