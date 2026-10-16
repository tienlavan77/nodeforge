// Verifies SL-to-AM-to-owner authority routing and authenticated Architecture decisions through durable Coder recovery.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { approvedBlockerArchitecture, assertArchitectureDisposition } from "../../src/modules/supervisor/blocker-decision-authority.js";

const boundaryQuote = "Reuse the existing in-process worker topology and public interfaces without changing system structure.";
const basis = { plan_id: "ARCH-PLAN", revision: 1, sha256: "a".repeat(64) };
const assessment = { rationale: "Use a compatible internal adapter; retain all owner constraints and ticket criteria.", changes_structure: false,
  changes_owner_scope: false, changes_security_policy: false, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: false };
const ownerProposal = { action: "owner_required", summary: "A proposed structure change exceeds delegated AM authority.",
  escalation: { boundary: "system_structure", rationale: "The proposal would replace the approved in-process topology.", authority_quote: boundaryQuote },
  proposal: { title: "Choose the system boundary", options: [{ id: "retain", description: "Keep the current in-process topology and use its existing adapter." },
    { id: "replace", description: "Approve a separate worker service, including isolation, compatibility, migration and rollout verification." }], recommended_option_id: "retain" } };

// Supplies a real recovery store with a trusted, revocable Architecture parent rather than an agent-authored approval.
async function architectureFixture(investigate, options = {}) {
  let revoked = false;
  const architecturePlans = { assertApproved: async (input) => {
    assert.deepEqual(input, { planId: basis.plan_id, revision: 1, sha256: basis.sha256 });
    if (revoked) throw new Error("Architecture approval was revoked");
    return { ...basis, project_id: "P", file_path: "approved-architecture.md", markdown: boundaryQuote };
  } };
  const fixture = await blockerRecoveryFixture({ investigate, recoveryOptions: { architecturePlans }, ...options });
  const assertReady = fixture.base.registry.assertReady;
  fixture.base.registry.assertReady = async (...input) => {
    const ready = await assertReady(...input);
    return { ...ready, plan: { ...ready.plan, proposal_id: `${basis.plan_id}-R1-${basis.sha256}`,
      source_path: "approved-architecture.md", source_sha256: basis.sha256 } };
  };
  return Object.assign(fixture, { revokeArchitecture: () => { revoked = true; } });
}

test("SL resolves within Sprint authority and resumes without an AM rubber stamp or owner question", async () => {
  const fixture = await blockerRecoveryFixture({ investigate: async (_job, resolution) => resolution });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "resume_pending");
    await fixture.recovery.tick();
    assert.deepEqual(fixture.calls, ["sprint_leader"]);
    assert.equal(fixture.base.integrations, 1);
    assert.equal(fixture.base.events.filter((event) => event.type.includes("owner_decision_required")).length, 0);
  } finally { await fixture.close(); }
});

test("SL cannot bypass AM by requesting an owner decision directly", async () => {
  const fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => job.stage === "sprint_leader" ? ownerProposal : resolution });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].stage, "architecture_manager");
    await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager"]);
    assert.equal(fixture.base.integrations, 1);
    assert.equal(fixture.base.events.filter((event) => event.type.includes("owner_decision_required")).length, 0);
  } finally { await fixture.close(); }
});

test("AM decides within the authenticated Architecture structure without creating owner approval", async () => {
  const fixture = await architectureFixture(async (job, resolution) => {
    assert.deepEqual(job.authority_context.architecture.basis, basis);
    return job.stage === "sprint_leader" ? { action: "architecture_required", summary: "Technical adapter choice belongs to AM." }
      : { ...resolution, authority_scope: "architecture", authority_quote: boundaryQuote, architecture_basis: basis, boundary_assessment: assessment };
  });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal(fixture.base.integrations, 1);
    assert.deepEqual((await fixture.ledger()).jobs[0].resolution.architecture_basis, basis);
    assert.equal((await fixture.base.checkpoints.load("TASK")).blocker_recovery.disposition.authority_scope, "architecture");
    assert.equal(fixture.base.events.filter((event) => event.type.includes("owner_decision_required")).length, 0);
  } finally { await fixture.close(); }
});

test("only AM crossing an evidenced owner boundary publishes concrete owner alternatives", async () => {
  const fixture = await architectureFixture(async (job) => job.stage === "sprint_leader"
    ? { action: "architecture_required", summary: "AM must assess structure impact." } : ownerProposal);
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "owner_required");
    assert.equal(fixture.base.events.filter((event) => event.type === "task.blocker.owner_decision_required").length, 1);
    const recovery = (await fixture.base.checkpoints.load("TASK")).blocker_recovery;
    assert.deepEqual(recovery.escalation, ownerProposal.escalation);
    assert.equal(recovery.proposal.options.length, 2);
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

test("AM cannot send routine uncertainty to the owner without identifying an approved boundary", async () => {
  const fixture = await architectureFixture(async (job) => job.stage === "sprint_leader"
    ? { action: "architecture_required", summary: "AM should decide." } : { ...ownerProposal, escalation: undefined });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "pending");
    assert.equal(fixture.base.events.filter((event) => event.type === "task.blocker.owner_decision_required").length, 0);
  } finally { await fixture.close(); }
});

test("changed or revoked Architecture authority cancels cached AM resume before Coder dispatch", async () => {
  const fixture = await architectureFixture(async (job, resolution) => job.stage === "sprint_leader"
    ? { action: "architecture_required", summary: "AM must verify the approved structure." }
    : { ...resolution, authority_scope: "architecture", authority_quote: boundaryQuote, architecture_basis: basis, boundary_assessment: assessment });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    fixture.revokeArchitecture();
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "cancelled");
    assert.equal(fixture.base.invocations, 1);
  } finally { await fixture.close(); }
});

test("AM cannot expand immutable ticket contracts or declare structure changes as resolved", async () => {
  for (const changes of [{ changes_structure: true }, { changes_ticket_contract: true }, { overrides_guardrails: true }]) {
    const fixture = await architectureFixture(async (job, resolution) => job.stage === "sprint_leader"
      ? { action: "architecture_required", summary: "Review the impact." }
      : { ...resolution, authority_scope: "architecture", authority_quote: boundaryQuote, architecture_basis: basis, boundary_assessment: { ...assessment, ...changes } });
    try {
      await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
      await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
      assert.equal(fixture.base.integrations, 0);
      assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
    } finally { await fixture.close(); }
  }
});

test("AM response-shape errors are corrected before owner escalation and automatic recovery", async () => {
  let attempts = 0;
  const fixture = await architectureFixture(async (job) => {
    if (job.stage === "sprint_leader") return { action: "architecture_required", summary: "Investigate the transport boundary." };
    attempts += 1;
    return attempts === 1 ? { ...ownerProposal, escalation: undefined } : ownerProposal;
  });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    const job = (await fixture.ledger()).jobs[0];
    assert.equal(attempts, 2);
    assert.equal(job.status, "owner_required");
    assert.equal(job.outcome_reason, "authority_required");
    assert.equal(job.disposition_attempts.at(-1).status, "accepted");
    assert.equal(job.validation_feedback, undefined);
  } finally { await fixture.close(); }
});

test("SL may use the approved Sprint boundary beyond the ticket's abbreviated objective", async () => {
  const quote = "The Sprint may reuse existing diagnostic adapters without changing public behavior.";
  const fixture = await blockerRecoveryFixture({ investigate: async (_job, resolution) => ({ ...resolution, authority_quote: quote }) });
  const assertReady = fixture.base.registry.assertReady;
  fixture.base.registry.assertReady = async (...input) => {
    const ready = await assertReady(...input);
    return { ...ready, plan: { ...ready.plan, content: { ...ready.plan.content, in_scope: quote } } };
  };
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.deepEqual(fixture.calls, ["sprint_leader"]);
    assert.equal(fixture.base.integrations, 1);
  } finally { await fixture.close(); }
});

test("AM authority cannot bypass an explicit existing-contract evidence prerequisite", async () => {
  const fixture = await architectureFixture(async (job, resolution) => job.stage === "sprint_leader"
    ? { action: "architecture_required", summary: "Investigate the contract." }
    : { ...resolution, authority_scope: "architecture", authority_quote: boundaryQuote, architecture_basis: basis, boundary_assessment: assessment },
  { reason: "CONTRACT_DECISION_REQUIRED" });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.base.integrations, 0);
    assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
    assert.match((await fixture.ledger()).jobs[0].last_error, /approved contract evidence/);
  } finally { await fixture.close(); }
});

test("Architecture authority rejects cross-project, source-path and parent-checksum mismatches", async () => {
  const plan = { proposal_id: `${basis.plan_id}-R1-${basis.sha256}`, source_path: "architecture.md", source_sha256: basis.sha256 };
  const parent = { ...basis, project_id: "P", file_path: plan.source_path, markdown: boundaryQuote };
  for (const changes of [{ project_id: "OTHER" }, { file_path: "other.md" }, { sha256: "b".repeat(64) }, { revision: 2 }]) {
    await assert.rejects(approvedBlockerArchitecture(plan, "P", { assertApproved: async () => ({ ...parent, ...changes }) }),
      { code: "BLOCKER_DISPOSITION_INVALID" });
  }
});

test("SL cannot claim AM authority and AM cannot resolve without the approved parent and impact assessment", () => {
  const value = { authority_quote: boundaryQuote, architecture_basis: basis, boundary_assessment: assessment };
  const architecture = { basis, markdown: boundaryQuote };
  for (const context of [{ job: { stage: "sprint_leader" }, architecture }, { job: { stage: "architecture_manager" }, architecture: null }]) {
    assert.throws(() => assertArchitectureDisposition(value, context), { code: "BLOCKER_DISPOSITION_INVALID" });
  }
  assert.throws(() => assertArchitectureDisposition({ ...value, boundary_assessment: null },
    { job: { stage: "architecture_manager" }, architecture }), { code: "BLOCKER_DISPOSITION_INVALID" });
});

test("AM corrects its identity using field feedback and resumes with a grounded paraphrase after restart", async () => {
  let attempts = 0;
  const fixture = await architectureFixture(async (job, resolution) => {
    if (job.stage === "sprint_leader") return { action: "architecture_required", summary: "AM must choose a compatible internal adapter." };
    attempts += 1;
    const passage = job.authority_context.passages.find((entry) => entry.scope === "architecture");
    if (attempts === 2) {
      assert.equal(job.validation_feedback[0].path, "/architecture_basis/revision");
      assert.equal(job.validation_feedback[0].expected, 1);
      assert.equal(job.disposition_attempts.at(-1).status, "rejected");
      assert.equal(JSON.parse(job.disposition_attempts.at(-1).response.text).architecture_basis.revision, 2);
    }
    return { ...resolution, authority_scope: "architecture", authority_quote: "Giữ nguyên kiến trúc và tái sử dụng giao diện hiện có.",
      authority_reference: { passage_id: passage.passage_id, rationale: "The internal adapter uses the approved in-process topology and leaves public interfaces unchanged." },
      architecture_basis: { ...basis, revision: attempts === 1 ? 2 : 1 }, boundary_assessment: assessment };
  });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "pending");
    assert.equal(fixture.base.invocations, 1);
    await fixture.recreate().tick(); await fixture.recovery.tick();
    assert.equal(fixture.base.integrations, 1);
    assert.equal((await fixture.ledger()).calls, 3);
    assert.equal((await fixture.ledger()).jobs[0].disposition_attempts.at(-1).status, "accepted");
    assert.equal(fixture.base.events.filter((event) => event.type.includes("owner_decision_required")).length, 0);
  } finally { await fixture.close(); }
});

test("Architecture identity failures report each precise field instead of one combined error", () => {
  for (const field of ["plan_id", "revision", "sha256"]) {
    assert.throws(() => assertArchitectureDisposition({ authority_quote: boundaryQuote, boundary_assessment: assessment,
      architecture_basis: { ...basis, [field]: field === "revision" ? 2 : "wrong" } },
    { job: { stage: "architecture_manager" }, architecture: { basis, markdown: boundaryQuote } }),
    (error) => error.validation_errors[0].path === `/architecture_basis/${field}` && error.retryable_disposition === true);
  }
  assert.throws(() => assertArchitectureDisposition({ authority_quote: boundaryQuote, boundary_assessment: assessment, architecture_basis: {} },
    { job: { stage: "architecture_manager" }, architecture: { basis, markdown: boundaryQuote } }),
  (error) => {
    assert.deepEqual(error.validation_errors.map((entry) => entry.path), ["/architecture_basis/plan_id", "/architecture_basis/revision", "/architecture_basis/sha256"]);
    return true;
  });
});
