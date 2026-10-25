/** Verifies that SL handoff examples satisfy the real validator and schema
 * correction retains completed work without manufacturing authority or source. */
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRolePrompt } from "../../src/modules/supervisor/blocker-role-prompt.js";
import { blockerCorrectionPrompt } from "../../src/modules/supervisor/blocker-disposition-correction.js";
import { validateTechnicalReconciliation } from "../../src/modules/supervisor/blocker-technical-reconciliation.js";
import { blockerResponseEvidence } from "../../src/modules/supervisor/blocker-validation.js";
import { createBlockerPromptContext } from "../../src/modules/supervisor/blocker-prompt-context.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

const technicalResult = { findings: ["Owner answered the retained question."], implementation_steps: ["Continue only the missing handler step."],
  verification_steps: ["Run the focused handler check."], admission: { status: "within_existing_permissions", rationale: "Existing permissions apply; no tool denial is overridden." } };

/** Represents provider replies from one assignment, including the real SDK
 * envelope, so correction guidance cannot silently cross a role or assignment. */
function attempt(value, overrides = {}) {
  return { stage: "sprint_leader", assignment_id: "A", status: "rejected", response: blockerResponseEvidence(value), ...overrides };
}

test("the SL resolved example includes the full validator-required technical handoff", () => {
  const line = blockerRolePrompt({ stage: "sprint_leader" }).split("\n").find((entry) => entry.startsWith("SL resolved example"));
  const decision = JSON.parse(line.slice(line.indexOf('{"action"')));
  assert.doesNotThrow(() => validateTechnicalReconciliation(decision, { technical_reconciliation: { work: {} } }));
  assert.equal(decision.authority_scope, "sprint");
});

test("checksum correction retains an earlier agent-authored result without accepting or merging decisions", () => {
  const earlier = { action: "resolved", technical_result: technicalResult, evidence: [{ path: "backend/source.js", sha256: "old" }] };
  const job = { stage: "sprint_leader", validation_feedback: [{ path: "/technical_result", reason: "technical_result_incomplete" }],
    disposition_attempts: [attempt({ payload: { decision: earlier } }), attempt({ action: "resolved", evidence: [{ sha256: "fresh" }] })] };
  const before = structuredClone(job);
  const prompt = blockerCorrectionPrompt(job);
  assert.match(prompt, /Updating evidence must not remove technical_result/);
  assert(prompt.includes(JSON.stringify(technicalResult)));
  assert.doesNotMatch(prompt, /"sha256":"old"/);
  assert.deepEqual(job, before);
  for (const overrides of [{ stage: "architecture_manager" }, { assignment_id: "B" }]) {
    const isolated = { ...job, disposition_attempts: [attempt(earlier, overrides), job.disposition_attempts[1]] };
    assert.doesNotMatch(blockerCorrectionPrompt(isolated), /PREVIOUS AGENT-AUTHORED/);
  }
});

test("SL schema correction reaches Coder only after the complete handoff validates across worker restart", async () => {
  let calls = 0;
  const fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    calls += 1;
    if (calls === 1) return { ...resolution, technical_result: technicalResult, evidence: [{ ...resolution.evidence[0], sha256: "b".repeat(64) }] };
    if (calls === 2) return resolution;
    assert(blockerCorrectionPrompt(job).includes(JSON.stringify(technicalResult)));
    return { ...resolution, technical_result: technicalResult };
  } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    const ledger = await fixture.ledger();
    ledger.jobs[0].technical_reconciliation = { work: { kind: "tooling", prerequisite: "Verify the existing handler." } };
    await fixture.base.store.save("blocker.recovery", ledger);
    await fixture.recreate().tick(); await fixture.recreate().tick();
    assert.equal(fixture.base.invocations, 1);
    assert.equal((await fixture.ledger()).jobs[0].validation_feedback[0].path, "/technical_result");
    await fixture.recreate().tick(); await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "resumed");
    assert.equal(fixture.base.invocations, 2);
    assert.equal(fixture.base.integrations, 1);
  } finally { await fixture.close(); }
});

test("compact and minimal SDK prompts retain correction context from earlier replies", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const job = { id: "J", stage: "sprint_leader", history: [], request: { project_id: "P", task_id: "TASK", payload: { execution_id: "E" }, ticket: fixture.ticket },
      validation_feedback: [{ path: "/technical_result", reason: "technical_result_incomplete" }],
      disposition_attempts: [attempt({ action: "resolved", technical_result: technicalResult }), attempt({ action: "resolved" })] };
    const prepared = await createBlockerPromptContext({ job, failureEvidence: null, projectRoot: fixture.base.workspace.projectRoot });
    assert(prepared.job.response_correction_context.includes(JSON.stringify(technicalResult)));
    assert.equal(prepared.minimalJob.response_correction_context, prepared.job.response_correction_context);
  } finally { await fixture.close(); }
});
