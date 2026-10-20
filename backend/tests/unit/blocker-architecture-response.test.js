// Exercises SL-owned Architecture consultation and Coder coordination without AM-to-Coder dispatch.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";

const request = { action: "coder_requested", summary: "Prepare the approved handler change.", guidance: "Use the AM answer and preserve existing gates.",
  coder_request: { questions: ["Propose the handler patch."], constraints: ["Preserve initialization and denied-operation boundaries."] } };
const technical_result = { findings: ["The approved handler contract permits the implementation."], implementation_steps: ["Extend selected handler composition."],
  verification_steps: ["Run focused handler tests."], admission: { status: "within_existing_permissions", rationale: "Existing mutation gates still apply." } };

// Builds a source-bound proposal without mutating the execution workspace.
function prepared(fixture) {
  return { action: "candidate_prepared", summary: "Prepared handler candidate.", candidate: { changes: [{ ...fixture.evidence,
    patch: `--- a/${fixture.evidence.path}\n+++ b/${fixture.evidence.path}\n@@ -1 +1,2 @@\n export const approvedHandler = true;\n+export const selected = true;\n`,
    rationale: "Implement the selected handler." }], verification_steps: ["Run focused handler tests."] } };
}

test("SL asks AM, AM answers SL, SL requests Coder and SL alone accepts its candidate", async () => {
  let fixture;
  fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    if (job.stage === "architecture_manager") return { ...resolution, technical_result };
    if (job.stage === "coder") return prepared(fixture);
    if (!job.architecture_response) return { action: "architecture_required", summary: "Clarify handler composition without changing the contract." };
    assert.equal(job.architecture_response.disposition.technical_result.implementation_steps[0], technical_result.implementation_steps[0]);
    return job.coder_exchange?.candidate ? { ...resolution, technical_result, candidate_review: { candidate_sha256: job.coder_exchange.candidate.sha256,
      verdict: "approved", comments: ["Preserves the Architecture answer and ticket scope."] } } : request;
  } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick();
    await fixture.recovery.tick();
    let job = (await fixture.ledger()).jobs[0];
    assert.equal(job.stage, "sprint_leader");
    assert.equal(job.status, "pending");
    assert.equal(fixture.base.invocations, 1);
    assert.equal((await fixture.ledger()).resumes, 0);
    await fixture.recreate().tick();
    assert.equal((await fixture.ledger()).jobs[0].coder_exchange.review_role, "sprint_leader");
    await fixture.recovery.tick();
    await fixture.recovery.tick();
    job = (await fixture.ledger()).jobs[0];
    assert.equal(job.status, "resume_pending");
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "sprint_leader", "coder", "sprint_leader"]);
    await fixture.recovery.tick();
    assert.equal(fixture.base.integrations, 1);
    assert.equal((await fixture.ledger()).execution_id, "EXEC");
  } finally { await fixture.close(); }
});

test("AM cannot request Coder directly and can answer SL while the old Coder proposal remains incomplete", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const job = { id: "J", stage: "architecture_manager", request: { ticket: fixture.ticket }, coder_exchange: { request_id: "R", review_role: "sprint_leader" } };
    const options = { job, plan: {}, fileService: fixture.base.fileService, projectRoot: fixture.base.workspace.projectRoot };
    await assert.rejects(validateBlockerDisposition(request, options), (error) => error.validation_errors[0].reason === "coder_request_invalid");
    assert.equal((await validateBlockerDisposition({ ...fixture.resolution, technical_result }, options)).action, "resolved");
  } finally { await fixture.close(); }
});

test("legacy paused Coder request resumes under SL coordination with its request identity and progress intact", async () => {
  const fixture = await blockerRecoveryFixture({ investigate: async () => request });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick();
    await fixture.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
    await fixture.base.store.withLock("blocker.recovery", async () => {
      const ledger = await fixture.ledger();
      ledger.jobs[0].coder_exchange.review_role = "architecture_manager";
      ledger.jobs[0].discovery_checkpoints = { coder: { sequence: 4, calls: 4, receipts: [{ tool: "read_lines", input: { path: "backend/src/handler.js" } }] } };
      await fixture.base.store.save("blocker.recovery", ledger);
    });
    const before = (await fixture.ledger()).jobs[0];
    const resumed = await fixture.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
    const after = (await fixture.ledger()).jobs[0];
    assert.equal(resumed.resumed_stage, "coder");
    assert.equal(after.coder_exchange.review_role, "sprint_leader");
    assert.equal(after.coder_exchange.request_id, before.coder_exchange.request_id);
    assert.deepEqual(after.discovery_checkpoints, before.discovery_checkpoints);
  } finally { await fixture.close(); }
});
