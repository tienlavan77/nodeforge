// Tests that immutable checkpoint AM authority reaches SL validation after later Coder failures without granting new permissions.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { retainBlockerContract } from "../../src/modules/supervisor/blocker-contract-evidence.js";
import { readBlockerContractDelegation, createBlockerContractRefresh } from "../../src/modules/supervisor/blocker-contract-delegation.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";
import { blockerResponseEvidence } from "../../src/modules/supervisor/blocker-validation.js";

const basis = { plan_id: "ARCH-PLAN", revision: 1, sha256: "a".repeat(64) };
const quote = "Preserve the existing approved interfaces and security restrictions while completing the implementation.";
const architecture = { basis, markdown: quote };
const assessment = { rationale: "Coordinate existing scope without changing security or acceptance.", changes_structure: false,
  changes_owner_scope: false, changes_security_policy: false, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: false };
const missing = "A contract requires approved contract evidence; source existence alone is not approval.";

// Creates a later blocked Coder checkpoint containing a real immutable AM receipt, with no in-memory delegation on its new recovery job.
async function fixture(t) {
  const f = await blockerRecoveryFixture({ reason: "CONTRACT_DECISION_REQUIRED", investigate: async (job, resolution) => {
    assert.equal(job.ticket_progress.architecture_decision?.guidance, "Preserve the denied security operation; continue only permitted implementation and focused verification.");
    return resolution;
  }, recoveryOptions: { architecturePlans: { assertApproved: async () => ({ ...basis, project_id: "P", file_path: "approved.md", markdown: quote }) } } });
  t.after(() => f.close());
  const assertReady = f.base.registry.assertReady;
  f.base.registry.assertReady = async (...args) => {
    const ready = await assertReady(...args);
    return { ...ready, plan: { ...ready.plan, proposal_id: `${basis.plan_id}-R1-${basis.sha256}`, source_path: "approved.md", source_sha256: basis.sha256 } };
  };
  await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
  const job = (await f.ledger()).jobs[0];
  const decision = { action: "resolved", authority_scope: "architecture", architecture_basis: basis, authority_quote: quote,
    summary: "Approved contract remains usable without the denied edit.", boundary_assessment: assessment, evidence: [f.evidence],
    guidance: "Preserve the denied security operation; continue only permitted implementation and focused verification." };
  const checkpoint = await f.base.checkpoints.load("TASK");
  const receipts = await retainBlockerContract({ fileService: f.base.fileService, checkpoint, job: { ...job, history: [{ stage: "architecture_manager", completed_at: 1000,
    actor: { agent_id: "AM", role: "architecture_manager" }, disposition: decision }] } });
  await f.base.checkpoints.save({ ...checkpoint, contract_decisions: receipts });
  return { f, job, decision, checkpoint: { ...checkpoint, contract_decisions: receipts }, fileService: f.base.fileService };
}

test("later contract blocker consumes checkpoint authority and resumes Coder without another AM call", async (t) => {
  const { f, checkpoint } = await fixture(t);
  f.recreate();
  await f.recovery.tick();
  assert.deepEqual(f.calls, ["sprint_leader"]);
  const job = (await f.ledger()).jobs[0];
  assert.equal(job.status, "resume_pending");
  assert.equal(job.sprint_delegation, undefined);
  assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, checkpoint.last_completed_turn);
  await f.recovery.tick();
  assert.equal(f.base.invocations, 2);
  assert.equal(f.base.integrations, 1);
  assert.deepEqual((await f.base.checkpoints.load("TASK")).contract_decisions, checkpoint.contract_decisions);
});

test("parked false missing-contract failure wakes once after restart and preserves the original request", async (t) => {
  const { f, job } = await fixture(t);
  await f.base.store.withLock("blocker.recovery", async () => {
    const ledger = await f.ledger();
    Object.assign(ledger.jobs[0], { status: "reconciliation_required", outcome_reason: "BLOCKER_DISPOSITION_INVALID",
      validation_feedback: [{ path: "/", reason: "BLOCKER_DISPOSITION_INVALID", message: missing }] });
    await f.base.store.save("blocker.recovery", ledger);
  });
  f.recreate(); await f.recovery.tick();
  const restored = (await f.ledger()).jobs[0];
  assert.equal(restored.status, "resume_pending");
  assert.deepEqual(restored.request, job.request);
  assert(restored.history.some((entry) => entry.event === "retained_contract_delegation_restored"));
  assert.deepEqual(f.calls, ["sprint_leader"]);
  Object.assign(restored, { outcome_reason: "BLOCKER_DISPOSITION_INVALID", validation_feedback: [{ message: missing }] });
  const refresh = createBlockerContractRefresh({ fileService: f.base.fileService, inspect: async () => ({ checkpoint: await f.base.checkpoints.load("TASK"), architecture }) });
  assert.equal(await refresh(restored), false);
});

test("retained decisions require exact receipt bytes, ticket identity and current approved Architecture", async (t) => {
  const x = await fixture(t);
  const options = { ...x, architecture };
  assert.deepEqual((await readBlockerContractDelegation(options)).delegation, x.decision);
  for (const key of ["project_id", "task_id"]) {
    await assert.rejects(readBlockerContractDelegation({ ...options, job: { ...x.job, request: { ...x.job.request, [key]: "FOREIGN" } } }), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
  }
  assert.equal((await readBlockerContractDelegation({ ...options, architecture: { ...architecture, basis: { ...basis, revision: 2 } } })).delegation, null);
  assert.equal((await readBlockerContractDelegation({ ...options, architecture: null })).delegation, null);
  const path = x.checkpoint.contract_decisions[0].path;
  await x.fileService.atomicWrite({ path, content: "{}", replace: true });
  await assert.rejects(readBlockerContractDelegation(options), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
});

test("retained contract does not clear a new access denial or supply absent source evidence", async (t) => {
  const { f, job, decision } = await fixture(t);
  const { plan } = await f.base.registry.assertReady();
  const options = { job, plan, architecture, fileService: f.base.fileService, projectRoot: f.base.workspace.projectRoot, contractDelegation: decision,
    verifyContractSource: async () => { throw Error("No invented contract source binding"); } };
  await assert.rejects(validateBlockerDisposition(f.resolution, { ...options, job: { ...job, reason_code: "ACCESS_REQUIRED" } }), /Sprint scope cannot resolve access/);
  await assert.rejects(validateBlockerDisposition({ ...f.resolution, evidence: [] }, options), /one to sixteen/);
  await assert.rejects(validateBlockerDisposition(f.resolution, { ...options, contractDelegation: undefined }), /approved contract evidence/);
});

test("Owner Stop prevents automatic restoration of the same parked contract job", async (t) => {
  const { f } = await fixture(t);
  await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
  f.recreate(); await f.recovery.tick();
  assert.deepEqual(f.calls, []);
});

test("production AM validation consumes an authenticated checkpoint receipt without routing it through Reviewer source access", async (t) => {
  const { f, decision, checkpoint } = await fixture(t);
  const ref = checkpoint.contract_decisions[0];
  const value = { ...decision, evidence: [...decision.evidence, { path: ref.path, sha256: ref.sha256 }] };
  await f.base.store.withLock("blocker.recovery", async () => {
    const ledger = await f.ledger();
    Object.assign(ledger.jobs[0], { stage: "architecture_manager", status: "pending" });
    await f.base.store.save("blocker.recovery", ledger);
  });
  f.recreate({ investigate: async () => value });
  await f.recovery.tick();
  const job = (await f.ledger()).jobs[0];
  assert.equal(job.stage, "sprint_leader");
  assert.equal(job.status, "pending");
  assert.deepEqual(job.architecture_response.disposition.evidence, value.evidence);
  assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, checkpoint.last_completed_turn);
});

test("Resume revalidates the retained AM answer after receipt-reader repair without another provider call", async (t) => {
  const { f, decision, checkpoint } = await fixture(t);
  const ref = checkpoint.contract_decisions[0];
  const value = { ...decision, evidence: [...decision.evidence, { path: ref.path, sha256: ref.sha256 }] };
  const ledger = await f.ledger();
  const current = ledger.jobs[0];
  Object.assign(current, { stage: "architecture_manager", status: "reconciliation_required", outcome_reason: "FILE_ROLE_FORBIDDEN",
    authority_consultations: [{ status: "assigned", identity: "retained-question" }],
    disposition_attempts: [{ stage: "architecture_manager", status: "rejected", response: blockerResponseEvidence(value) }] });
  await f.base.store.save("blocker.recovery", ledger);
  f.recreate({ investigate: async () => assert.fail("Retained validated answer must not invoke the provider again") });
  const resumed = await f.recovery.resumeStage({ projectId: ledger.project_id, taskId: ledger.task_id, executionId: ledger.execution_id, jobId: current.id });
  assert.equal(resumed.stage, "architecture_manager");
  await f.recovery.tick();
  const job = (await f.ledger()).jobs[0];
  assert.equal(job.stage, "sprint_leader"); assert.equal(job.status, "pending");
  assert.equal(job.disposition_attempts.at(-1).status, "accepted");
  assert.deepEqual(job.architecture_response.disposition.evidence, value.evidence);
  assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, checkpoint.last_completed_turn);
});
