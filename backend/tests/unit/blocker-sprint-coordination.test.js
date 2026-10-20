// Verifies SL/Coder implementation recovery without repeated Architecture research or widened authority.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";
import { scheduleTechnicalReconciliation } from "../../src/modules/supervisor/blocker-technical-reconciliation.js";
import { restoreSprintRecovery, delegateSprintRecovery } from "../../src/modules/supervisor/blocker-sprint-handoff.js";

const request = { action: "coder_requested", summary: "Prepare the in-scope handler change.", guidance: "Keep the approved handler contract unchanged.",
  coder_request: { questions: ["Propose the handler patch and focused test."], constraints: ["Preserve existing approval denials and immutable criteria."] } };

// Produces a source-bound proposal without mutating the workspace or dispatching execution tools.
function prepared(fixture) {
  return { action: "candidate_prepared", summary: "Handler-only candidate.", candidate: { changes: [{ ...fixture.evidence,
    patch: `--- a/${fixture.evidence.path}\n+++ b/${fixture.evidence.path}\n@@ -1 +1,2 @@\n export const approvedHandler = true;\n+export const selected = true;\n`,
    rationale: "Implement selected routing under the existing contract." }], verification_steps: ["Run focused handler tests."] } };
}

// Resolves implementation coordination at Sprint authority, without granting execution-tool approval.
function approved(job, resolution) {
  return { ...resolution, authority_scope: "sprint", candidate_review: { candidate_sha256: job.coder_exchange.candidate.sha256,
    verdict: "approved", comments: ["Matches the approved handler contract."] }, technical_result: { findings: ["No Architecture change is needed."],
    implementation_steps: ["Apply the reviewed handler patch."], verification_steps: ["Run focused handler tests."],
    admission: { status: "within_existing_permissions", rationale: "Existing runtime gates still apply." } } };
}

test("SL obtains and reviews Coder candidate across restart without invoking AM", async () => {
  let fixture;
  fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => job.stage === "coder"
    ? prepared(fixture) : job.coder_exchange?.candidate ? approved(job, resolution) : request });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    const original = await fixture.base.checkpoints.load("TASK");
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].coder_exchange.review_role, "sprint_leader");
    await fixture.recreate().tick();
    assert.equal((await fixture.ledger()).jobs[0].stage, "sprint_leader");
    assert.equal((await fixture.base.checkpoints.load("TASK")).failure.at, original.failure.at);
    await fixture.recovery.tick();
    await fixture.recovery.tick();
    assert.deepEqual(fixture.calls, ["sprint_leader", "coder", "sprint_leader"]);
    assert.equal(fixture.base.integrations, 1);
    assert.equal((await fixture.ledger()).execution_id, "EXEC");
    assert.equal((await fixture.ledger()).jobs[0].status, "resumed");
  } finally { await fixture.close(); }
});

test("missing evidence parks SL across restarts without additional research calls", async () => {
  const fixture = await blockerRecoveryFixture({ investigate: async () => ({ action: "reconciliation_required", summary: "Source-bound input is unavailable.",
    guidance: "Supply the scoped claim observation before continuing.", reconciliation: { kind: "dependency", prerequisite: "Current claim ownership.",
      completed_checks: ["No current ownership receipt is supplied."], next_check: "Read a new authorized claim observation.", waiting_for: ["Node: project-scoped claim ownership receipt."] } }) });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    for (let i = 0; i < 6; i += 1) await fixture.recreate().tick();
    const job = (await fixture.ledger()).jobs[0];
    assert.deepEqual(fixture.calls, ["sprint_leader"]);
    assert.equal(job.status, "reconciliation_required");
    assert.equal(job.outcome_reason, "technical_reconciliation_waiting_for_evidence");
    assert.equal(job.technical_reconciliation.work.waiting_for.length, 1);
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

test("unchanged source with differently worded observations is not research progress", () => {
  const job = { stage: "sprint_leader", request: {}, history: [] };
  const value = { summary: "Need implementation input.", guidance: "Read selected source.", evidence: [{ path: "handler.js", sha256: "a".repeat(64) }],
    reconciliation: { kind: "source_revision", prerequisite: "Compare handler.", completed_checks: ["Read handler source."], next_check: "Compare selected handler." } };
  scheduleTechnicalReconciliation(job, value, 1);
  scheduleTechnicalReconciliation(job, { ...value, reconciliation: { ...value.reconciliation, completed_checks: ["Found another incidental detail in the same source."] } }, 2);
  assert.equal(job.outcome_reason, "technical_reconciliation_no_progress");
  assert.equal(job.status, "notification_pending");
});

test("explicit resume hands legacy AM implementation research to SL and preserves its dossier", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick();
    await fixture.base.store.withLock("blocker.recovery", async () => {
      const ledger = await fixture.ledger();
      ledger.jobs[0].technical_reconciliation = { work: { kind: "dependency", prerequisite: "Unproven runtime audit request." } };
      ledger.jobs[0].coder_exchange = { request_id: "OLD", coder_feedback: { summary: "Missing runtime dossier." } };
      await fixture.base.store.save("blocker.recovery", ledger);
    });
    const before = (await fixture.ledger()).jobs[0];
    await fixture.base.occupancy.claim({ agentId: "AM", taskId: "TASK", supervisorId: `BLOCKER-${before.id}`, role: "architecture_manager" });
    await fixture.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
    const result = await fixture.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
    assert.equal(result.resumed_stage, "sprint_leader");
    assert.equal(await fixture.base.occupancy.getByTask("TASK", "architecture_manager"), null);
    const job = (await fixture.ledger()).jobs[0];
    assert.equal(job.coder_exchange.review_role, "sprint_leader");
    assert.equal(job.history.at(-1).previous_exchange.request_id, "OLD");
    assert.equal((await fixture.base.checkpoints.load("TASK")).blocker_recovery.stage, "sprint_leader");
  } finally { await fixture.close(); }
});

for (const boundary of ["ACCESS_REQUIRED", "SECURITY_RISK", "fulfillment", "technical_design"]) {
  test(`implementation handoff preserves ${boundary} Architecture responsibility`, () => {
    const job = { stage: "architecture_manager", status: "cancelled", history: [], reason_code: boundary,
      ...(boundary === "fulfillment" ? { fulfillment_decision_id: "OWNER" } : {}), technical_reconciliation: { work: { kind: boundary === "technical_design" ? "technical_design" : "dependency" } } };
    restoreSprintRecovery(job, 1);
    assert.equal(job.stage, "architecture_manager");
    assert.equal(job.status, "cancelled");
  });
}

test("SL implementation coordination cannot resolve access blockers or impersonate Architecture", async () => {
  const fixture = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED" });
  try {
    const job = { stage: "sprint_leader", reason_code: "ACCESS_REQUIRED", request: { ticket: fixture.ticket } };
    const options = { job, plan: {}, fileService: fixture.base.fileService, projectRoot: fixture.base.workspace.projectRoot };
    await assert.rejects(validateBlockerDisposition(fixture.resolution, options), (error) => error.validation_errors[0].reason === "access_or_security_authority_required");
    await assert.rejects(validateBlockerDisposition({ ...fixture.resolution, authority_scope: "architecture" }, options), { code: "BLOCKER_DISPOSITION_INVALID" });
    await assert.rejects(validateBlockerDisposition({ ...fixture.resolution, action: "sprint_required" }, options), { code: "BLOCKER_DISPOSITION_INVALID" });
  } finally { await fixture.close(); }
});

// Keeps delegation source-bound when AM hands an existing contract comparison back to SL.
test("AM delegates an unchanged contract to SL with exact authority and live evidence, never by narrative alone", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const quote = "Preserve the approved API structure and existing project request identifiers.";
    const architecture = { basis: { plan_id: "PARENT", revision: 1, sha256: "a".repeat(64) }, markdown: quote };
    const job = { stage: "architecture_manager", reason_code: "CONTRACT_DECISION_REQUIRED", request: { ticket: {
      ...fixture.ticket, execution_policy: { contract_evidence: [{ ...fixture.evidence, sha256: "b".repeat(64), authority_quote: quote }] }
    } }, history: [] };
    const options = { job, plan: {}, architecture, fileService: fixture.base.fileService, projectRoot: fixture.base.workspace.projectRoot };
    const handoff = { action: "sprint_required", summary: "Implementation belongs to SL.", guidance: "Preserve the approved API and implement project service routing.",
      authority_scope: "architecture", authority_quote: quote, architecture_basis: architecture.basis, evidence: [fixture.evidence],
      boundary_assessment: { rationale: "The contract is unchanged; only service selection needs implementation.", changes_structure: false,
        changes_owner_scope: false, changes_security_policy: false, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: false } };
    for (const invalid of [{ ...handoff, evidence: undefined }, { ...handoff, architecture_basis: { ...architecture.basis, revision: 2 } },
      { ...handoff, boundary_assessment: { ...handoff.boundary_assessment, changes_structure: true } }]) {
      await assert.rejects(validateBlockerDisposition(invalid, options), { code: "BLOCKER_DISPOSITION_INVALID" });
    }
    const verified = await validateBlockerDisposition(handoff, options);
    delegateSprintRecovery(job, verified, 1);
    assert.equal(job.status, "pending");
    assert.equal((await validateBlockerDisposition(fixture.resolution, options)).action, "resolved");
    delete job.sprint_delegation;
    await assert.rejects(validateBlockerDisposition(fixture.resolution, options), { code: "BLOCKER_DISPOSITION_INVALID" });
    job.sprint_delegation = verified;
    await fixture.base.fileService.atomicWrite({ path: fixture.evidence.path, content: "source changed after delegation\n", replace: true });
    await assert.rejects(validateBlockerDisposition(fixture.resolution, options), { code: "BLOCKER_DISPOSITION_INVALID" });
  } finally { await fixture.close(); }
});

// Prevents an old AM candidate-review role from trapping a consultation after it moves to SL.
test("implementation reassignment retains the Coder request and changes its coordinator to SL", () => {
  const job = { stage: "architecture_manager", request: {}, history: [], coder_exchange: { request_id: "AM-REQUEST", review_role: "architecture_manager" } };
  scheduleTechnicalReconciliation(job, { action: "reconciliation_required", summary: "Implementation comparison remains.", guidance: "SL should coordinate the handler patch.",
    reconciliation: { kind: "source_revision", prerequisite: "Selected handler proposal.", completed_checks: ["The contract is unchanged."], next_check: "Request a narrow implementation candidate." } }, 1);
  assert.equal(job.stage, "sprint_leader");
  assert.equal(job.coder_exchange.review_role, "sprint_leader");
  assert.equal(job.history.find((event) => event.event === "sprint_recovery_assigned").previous_exchange.request_id, "AM-REQUEST");
});

// Separates implementation coordination from unresolved permission authority in legacy ACCESS_REQUIRED checkpoints.
test("an AM all-false assessment returns legacy ACCESS implementation coordination to SL without clearing the access gate", async () => {
  const fixture = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED" });
  try {
    const job = { stage: "architecture_manager", status: "cancelled", reason_code: "ACCESS_REQUIRED", request: { ticket: fixture.ticket },
      technical_reconciliation: { work: { kind: "dependency" } }, history: [{ stage: "architecture_manager", disposition: { boundary_assessment: {
        changes_structure: false, changes_owner_scope: false, changes_security_policy: false, changes_data_semantics: false,
        overrides_guardrails: false, changes_ticket_contract: false } } }] };
    restoreSprintRecovery(job, 1);
    assert.equal(job.stage, "sprint_leader");
    assert.equal(job.reason_code, "ACCESS_REQUIRED");
    const resolution = { ...fixture.resolution, technical_result: { findings: ["Implementation coordination is in scope."],
      implementation_steps: ["Prepare a permitted candidate."], verification_steps: ["Run focused routing checks."],
      admission: { status: "within_existing_permissions", rationale: "No new permissions are requested." } } };
    await assert.rejects(validateBlockerDisposition(resolution, { job, plan: {}, fileService: fixture.base.fileService,
      projectRoot: fixture.base.workspace.projectRoot }), (error) => error.validation_errors[0].reason === "access_or_security_authority_required");
  } finally { await fixture.close(); }
});
