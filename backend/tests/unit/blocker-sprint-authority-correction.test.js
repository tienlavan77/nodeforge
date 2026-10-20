// Reproduces SL copying AM authority and verifies recovery preserves the contract, checkpoint and approval boundaries.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { blockerRolePrompt } from "../../src/modules/supervisor/blocker-role-prompt.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";

const quote = "Keep project-local data and the existing public contract; implement compatible internal adapters.";
const basis = { plan_id: "ARCH", revision: 1, sha256: "a".repeat(64) };
const assessment = { rationale: "Compatible implementation preserves all approved boundaries.", changes_structure: false,
  changes_owner_scope: false, changes_security_policy: false, changes_data_semantics: false,
  overrides_guardrails: false, changes_ticket_contract: false };

// Supplies authenticated Architecture authority for the contract consultation and retained SL handoff.
async function fixtureFor(investigate) {
  const fixture = await blockerRecoveryFixture({ reason: "CONTRACT_DECISION_REQUIRED", investigate, recoveryOptions: {
    architecturePlans: { assertApproved: async () => ({ ...basis, project_id: "P", file_path: "architecture.md", markdown: quote }) }
  } });
  const ready = fixture.base.registry.assertReady;
  fixture.base.registry.assertReady = async (...args) => {
    const value = await ready(...args);
    return { ...value, plan: { ...value.plan, proposal_id: `${basis.plan_id}-R1-${basis.sha256}`,
      source_path: "architecture.md", source_sha256: basis.sha256 } };
  };
  return fixture;
}

// Represents AM's source-bound contract decision, which SL must consume without impersonating its authority.
function answer(resolution) {
  return { ...resolution, authority_scope: "architecture", authority_quote: quote, architecture_basis: basis,
    boundary_assessment: assessment };
}

test("role prompts distinguish a consulted AM contract from SL's own Sprint decision", () => {
  const response = { disposition: { action: "resolved", authority_scope: "architecture" } };
  const sl = blockerRolePrompt({ stage: "sprint_leader", architecture_response: response });
  assert.match(sl, /authority_scope\?: sprint,/);
  assert.doesNotMatch(sl.split("\n")[0], /sprint\|architecture|owner_required|governance_required/);
  assert.match(sl, /Never copy AM's architecture authority_scope/);
  assert.match(sl, /Select a scope=sprint/);
  assert.match(sl, /Continue the missing implementation from the Coder checkpoint/);
  assert.match(sl, /specific unresolved Architecture decision/);
  assert.match(sl, /ARCHITECTURE ANSWER RETURNED TO SL/);
  assert.match(blockerRolePrompt({ stage: "architecture_manager" }), /authority_scope\?: sprint\|architecture/);
  assert.match(blockerRolePrompt({ stage: "coder" }), /cannot decide Sprint or Architecture authority/);
});

test("SL corrects copied AM scope after restart and resumes the same Coder checkpoint without another AM vote", async () => {
  let slCalls = 0;
  const fixture = await fixtureFor(async (job, resolution) => {
    if (job.stage === "architecture_manager") return answer(resolution);
    if (!job.architecture_response) return { action: "architecture_required", summary: "Resolve the missing compatibility contract." };
    slCalls += 1;
    assert.equal(job.sprint_delegation.authority_scope, "architecture");
    if (slCalls === 1) return answer(resolution);
    assert.equal(job.validation_feedback[0].reason, "role_not_authorized");
    assert.equal(job.validation_feedback[0].expected, "sprint");
    return { ...resolution, authority_scope: "sprint" };
  });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    const before = await fixture.base.checkpoints.load("TASK");
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    let job = (await fixture.ledger()).jobs[0];
    assert.equal(job.status, "pending");
    assert.equal(job.disposition_attempts.at(-1).status, "rejected");
    assert.equal(fixture.base.integrations, 0);
    assert.equal(job.sprint_delegation.authority_scope, "architecture");
    await fixture.recreate().tick();
    job = (await fixture.ledger()).jobs[0];
    assert.equal(job.status, "resume_pending");
    assert.equal(job.resolution.authority_scope, "sprint");
    assert.equal(job.architecture_response.disposition.authority_scope, "architecture");
    assert.equal((await fixture.base.checkpoints.load("TASK")).last_completed_turn, before.last_completed_turn);
    await fixture.recovery.tick();
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "sprint_leader", "sprint_leader"]);
    assert.equal(fixture.base.integrations, 1);
    assert.equal((await fixture.ledger()).execution_id, "EXEC");
  } finally { await fixture.close(); }
});

test("unchanged invalid SL authority stops repeated correction without dispatching Coder", async () => {
  const fixture = await fixtureFor(async (job, resolution) => job.stage === "architecture_manager" || job.architecture_response
    ? answer(resolution) : { action: "architecture_required", summary: "Resolve the compatibility contract." });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    for (let i = 0; i < 6; i += 1) await fixture.recovery.tick();
    const job = (await fixture.ledger()).jobs[0];
    assert.equal(job.outcome_reason, "disposition_correction_no_progress");
    assert.equal(fixture.calls.filter((role) => role === "architecture_manager").length, 1);
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

test("SL can ask AM a distinct remaining design question after consuming an answer", async () => {
  const fixture = await fixtureFor(async (job, resolution) => job.stage === "architecture_manager" ? answer(resolution)
    : { action: "architecture_required", summary: job.architecture_response
      ? "Clarify the remaining legacy-row recovery contract." : "Resolve the compatibility contract." });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    const job = (await fixture.ledger()).jobs[0];
    assert.equal(job.stage, "architecture_manager");
    assert.equal(job.status, "pending");
    assert.match(job.resolution.summary, /remaining legacy-row/);
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

test("Sprint coordination cannot accept changed AM source or architecture identity", async () => {
  const fixture = await fixtureFor(async (job, resolution) => job.stage === "architecture_manager" ? answer(resolution)
    : { action: "architecture_required", summary: "Resolve the compatibility contract." });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    const job = (await fixture.ledger()).jobs[0];
    const options = { job, plan: {}, architecture: { basis, markdown: quote }, fileService: fixture.base.fileService,
      projectRoot: fixture.base.workspace.projectRoot };
    await assert.rejects(validateBlockerDisposition(fixture.resolution, { ...options, architecture: {
      basis: { ...basis, revision: 2 }, markdown: quote
    } }), (error) => error.validation_errors[0].reason === "identity_mismatch");
    await fixture.base.fileService.atomicWrite({ path: fixture.evidence.path, content: "changed source\n", replace: true });
    await assert.rejects(validateBlockerDisposition(fixture.resolution, options), (error) => error.validation_errors[0].reason === "evidence_stale");
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});
