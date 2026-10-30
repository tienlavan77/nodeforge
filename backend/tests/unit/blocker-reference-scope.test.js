// Reproduces AM's Sprint-reference/Architecture-scope mismatch and verifies actionable, authority-preserving correction.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { blockerAuthorityPassages, resolveBlockerAuthority } from "../../src/modules/supervisor/blocker/blocker-authority-passages.js";
import { assertArchitectureDisposition } from "../../src/modules/supervisor/blocker/blocker-decision-authority.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker/blocker-recovery-contract.js";

const context = { plan: { content: {} }, ticket: { objective: "Reuse the existing approved handler without changing the public contract." },
  architecture: { basis: { plan_id: "ARCH", revision: 1, sha256: "a".repeat(64) }, markdown: "Keep the existing in-process topology and all public interfaces unchanged." } };
const rationale = "Reuse the approved internal handler without changing scope, interfaces or delegated authority.";

test("a genuine Sprint ID reported as Architecture gets scope feedback and valid alternatives, not unknown-reference feedback", () => {
  const passages = blockerAuthorityPassages(context);
  const sprint = passages.find((entry) => entry.scope === "sprint");
  const architecture = passages.find((entry) => entry.scope === "architecture");
  const value = { authority_scope: "architecture", authority_reference: { passage_id: sprint.passage_id, rationale } };
  assert.throws(() => resolveBlockerAuthority(value, context), (error) => {
    const feedback = error.validation_errors[0];
    assert.equal(feedback.path, "/authority_scope");
    assert.equal(feedback.reason, "reference_scope_mismatch");
    assert.equal(feedback.expected, "sprint");
    assert.equal(feedback.received, "architecture");
    assert.equal(feedback.passage_id, sprint.passage_id);
    assert.ok(feedback.valid_references.some((entry) => entry.passage_id === architecture.passage_id && entry.scope === "architecture"));
    assert.equal(error.retryable_disposition, true);
    return true;
  });
  assert.equal(value.authority_scope, "architecture");
  assert.equal(resolveBlockerAuthority({ ...value, authority_reference: { passage_id: architecture.passage_id, rationale } }, context), context.architecture.markdown);
});

test("unknown references receive bounded same-scope alternatives without becoming approved by fallback", () => {
  assert.throws(() => resolveBlockerAuthority({ authority_scope: "architecture", authority_reference: { passage_id: "invented", rationale } }, context), (error) => {
    const feedback = error.validation_errors[0];
    assert.equal(feedback.reason, "reference_unknown");
    assert.equal(feedback.expected.scope, "architecture");
    assert.ok(feedback.expected.references.length > 0 && feedback.expected.references.length <= 8);
    assert.ok(feedback.expected.references.every((entry) => entry.scope === "architecture"));
    return true;
  });
});

test("AM Architecture-bound delegation rejects a Sprint reference with the required scope", () => {
  const sprint = blockerAuthorityPassages(context).find((entry) => entry.scope === "sprint");
  assert.throws(() => assertArchitectureDisposition({ authority_scope: "sprint", architecture_basis: context.architecture.basis }, {
    job: { stage: "architecture_manager" }, architecture: context.architecture, authorityQuote: sprint.text
  }), (error) => error.validation_errors[0].reason === "reference_scope_mismatch"
    && error.validation_errors[0].expected === "architecture");
});

test("AM corrects the diagnosed scope after restart only when Sprint authority genuinely permits resume", async () => {
  let attempts = 0;
  const fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    if (job.stage === "sprint_leader" && job.architecture_response) return job.architecture_response.disposition;
    if (job.stage === "sprint_leader") return { action: "architecture_required", summary: "Ask AM to reconcile the technical blocker." };
    attempts += 1;
    const passage = job.authority_context.passages.find((entry) => entry.scope === "sprint");
    if (attempts === 2) assert.equal(job.validation_feedback[0].reason, "reference_scope_mismatch");
    return { ...resolution, authority_scope: attempts === 1 ? "architecture" : "sprint",
      authority_reference: { passage_id: passage.passage_id, rationale } };
  } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "pending");
    assert.equal(fixture.base.invocations, 1);
    await fixture.recreate().tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).calls, 4);
    assert.equal(fixture.base.integrations, 1);
  } finally { await fixture.close(); }
});

test("correcting the reference scope alone cannot unblock an unapproved lifecycle transport contract", async () => {
  let attempts = 0;
  const fixture = await blockerRecoveryFixture({ reason: "CONTRACT_DECISION_REQUIRED", investigate: async (job, resolution) => {
    if (job.stage === "sprint_leader") return { action: "architecture_required", summary: "AM must reconcile the transport contract." };
    attempts += 1;
    return { ...resolution, authority_scope: attempts === 1 ? "architecture" : "sprint",
      authority_reference: { passage_id: job.authority_context.passages.find((entry) => entry.scope === "sprint").passage_id, rationale } };
  } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    for (let turn = 0; turn < 4; turn += 1) await fixture.recovery.tick();
    const job = (await fixture.ledger()).jobs[0];
    assert.equal(job.status, "reconciliation_required");
    assert.match(job.last_error, /approved contract evidence/);
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

// An AM escalation may cite an Architecture passage under the top-level declared scope; a wrong scope still fails closed.
test("owner escalation requires evidenced structure risk and preserves scope and boundary validation", async () => {
  const context = { plan: { content: {} }, ticket: { objective: "Implement lifecycle without inventing a public management contract." },
    architecture: { basis: { plan_id: "ARCH", revision: 1, sha256: "a".repeat(64) }, markdown: "Public API structure is owner-approved; new routes, prefixes or payloads require explicit owner authority." } };
  const passage = blockerAuthorityPassages(context).find((entry) => entry.scope === "architecture");
  const job = { stage: "architecture_manager", request: { ticket: context.ticket } };
  const value = { action: "owner_required", summary: "A new management transport contract exceeds AM authority.", authority_scope: "architecture",
    boundary_assessment: { rationale: "The proposed separate management service changes approved system structure.",
      changes_structure: true, changes_owner_scope: false, changes_security_policy: false, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: false },
    evidence: [{ path: "backend/src/handler.js", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }],
    escalation: { boundary: "system_structure", rationale: "Only the owner can approve a separate management service.",
      authority_reference: { passage_id: passage.passage_id, rationale: "The approved Architecture text fixes public API structure as owner authority." } },
    proposal: { title: "Management transport contract", options: [{ id: "approve", description: "Approve the proposed add/remove/list contract." },
      { id: "defer", description: "Defer transport work until an approved contract exists." }], recommended_option_id: "approve" } };
  const validate = (entry, customJob = job) => validateBlockerDisposition(entry, { job: customJob, plan: context.plan, architecture: context.architecture,
    fileService: { readFile: async () => "" }, projectRoot: process.cwd() });
  const accepted = await validate(value);
  assert.equal(accepted.escalation.authority_quote, context.architecture.markdown);
  await assert.rejects(validate({ ...value, authority_scope: "sprint" }), (error) => {
    assert.equal(error.validation_errors[0].reason, "reference_scope_mismatch");
    assert.equal(error.validation_errors[0].expected, "architecture");
    assert.equal(error.validation_errors[0].received, "sprint");
    return true;
  });
  await assert.rejects(validate({ ...value, escalation: { ...value.escalation, boundary: "owner_scope" } }), (error) => {
    assert.equal(error.validation_errors[0].reason, "escalation_boundary_mismatch");
    return true;
  });
  await assert.rejects(validate({ ...value, evidence: undefined }), (error) => {
    assert.equal(error.validation_errors[0].reason, "evidence_invalid");
    return true;
  });
  await assert.rejects(validate({ ...value, evidence: undefined }, { ...job, reason_code: "ACCESS_REQUIRED" }), (error) => error.validation_errors[0].reason === "evidence_invalid");
  await assert.rejects(validate({ ...value, boundary_assessment: { ...value.boundary_assessment, changes_structure: false, changes_owner_scope: true },
    escalation: { ...value.escalation, boundary: "owner_scope" } }), (error) => error.validation_errors[0].reason === "structure_risk_required");
  const fulfilledResolved = await validate({
    action: "resolved", summary: "AM finalized HTTP contract within approved structure.", guidance: "Implement POST /lifecycle/add with {root:string}.",
    authority_scope: "architecture", authority_reference: { passage_id: passage.passage_id, rationale: "Uses approved structure without new public boundary." },
    architecture_basis: context.architecture.basis, evidence: value.evidence,
    boundary_assessment: { ...value.boundary_assessment, changes_structure: false }
  }, { ...job, reason_code: "CONTRACT_DECISION_REQUIRED", fulfillment_decision_id: "BLOCKER-DECISION-1" });
  assert.equal(fulfilledResolved.action, "resolved");
});
