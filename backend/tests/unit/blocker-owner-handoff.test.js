// Verifies owner choices lead to one durable AM contract draft rather than repeated Coder launches or policy votes.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createTicketBlockerDecisionService } from "../../src/application/ticket-blocker-decision-service.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";
import { createBlockerGovernanceHandoff } from "../../src/modules/supervisor/blocker-governance-handoff.js";

const proposal = { action: "owner_required", summary: "A transport change needs owner direction.",
  boundary_assessment: { rationale: "A new transport changes the approved contract.",
    changes_structure: false, changes_owner_scope: false, changes_security_policy: false, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: true },
  escalation: { boundary: "explicit_owner_guardrail", rationale: "A new transport changes the approved contract.", authority_quote: "Reuse backend/src/handler.js under the existing approved contract." },
  proposal: { title: "Transport direction", options: [{ id: "http", description: "Use HTTP; AM finalizes schemas and binding." }, { id: "defer", description: "Defer transport." }], recommended_option_id: "http" } };

// Creates real plan persistence beside the parked execution to cover provider-to-governance handoff.
async function fixture({ fail, repeatedVote = false } = {}) {
  let latestJob;
  const f = await blockerRecoveryFixture({ reason: "CONTRACT_DECISION_REQUIRED", investigate: async (job, resolution) => {
    latestJob = job;
    if (!job.fulfillment_decision_id) return job.stage === "sprint_leader" ? { action: "architecture_required", summary: "AM must finalize transport." } : { ...proposal, evidence: resolution.evidence };
    if (fail) throw Object.assign(new Error("Provider rejected request: 402"), { code: "CONFIGURATION_ERROR" });
    if (repeatedVote) return { ...proposal, evidence: resolution.evidence };
    return { action: "governance_required", summary: "Concrete contract is ready for exact revision review.", contract_draft: {
      title: "Finalize management transport", markdown: "POST /lifecycle/add accepts exactly {root:string}. Roots are absolute and canonical. CLI delegates to the existing server. Preserve every original acceptance criterion and require governance binding before execution.", evidence: [f.evidence] } };
  } });
  const planFiles = createFileService({ projectRoot: f.base.workspace.projectRoot, allowPlanStorage: true });
  const database = await createDatabaseService({ dataDir: f.base.workspace.projectRoot, runtimeDir: ".db" });
  const plans = createHumanPlanStore({ projectId: "P", database, fileService: planFiles });
  const recreate = () => f.recreate({ plans, planFileService: planFiles, projectId: "P" });
  recreate();
  await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
  await f.recovery.tick(); await f.recovery.tick(); await f.recovery.tick();
  const service = createTicketBlockerDecisionService({ projectId: "P", ticketStatusStore: { ...f.base.statusStore,
    updateStatus: (...args) => { f.base.statusStore.updateStatus(...args); return f.base.statusStore.get("TASK"); } },
    checkpoints: f.base.checkpoints, fulfillOwnerDecision: (input) => f.recovery.fulfillOwnerDecision(input) });
  return { f, plans, planFiles, recreate, service, job: () => latestJob, close: async () => { await database.close(); await f.close(); } };
}

test("owner choice dispatches AM once, persists a canonical draft and never auto-approves or resumes Coder", async () => {
  const x = await fixture();
  try {
    const { f } = x;
    const decided = await x.service.decide({ requestedProjectId: "P", ticketId: "TASK", actor: "OWNER", optionId: "http" });
    assert.equal(decided.handoff.resumed_stage, "architecture_manager");
    assert.equal(decided.status, "needs_human_review");
    await x.recreate().recover();
    await Promise.all([f.recovery.fulfillOwnerDecision({ projectId: "P", ticketId: "TASK" }), f.recovery.fulfillOwnerDecision({ projectId: "P", ticketId: "TASK" })]);
    const callsBefore = (await f.ledger()).calls;
    await f.recovery.tick(); await f.recovery.tick();
    const checkpoint = await f.base.checkpoints.load("TASK");
    const receipt = checkpoint.blocker_recovery.governance_handoff;
    assert.equal(checkpoint.blocker_recovery.status, "governance_required");
    assert.equal(receipt.execution_authorized, false);
    const revision = await x.plans.getRevision({ planId: receipt.plan_id, revision: receipt.revision });
    assert.equal(revision.status, "awaiting_human_approval");
    assert.equal(revision.decision, null);
    assert.deepEqual(revision.content.ticket_specs[0], f.ticket);
    assert.deepEqual(revision.content.acceptance_criteria, f.ticket.acceptance_criteria);
    assert.equal(revision.content.governance_handoff.execution_id, "EXEC");
    assert.match(await x.planFiles.readFile({ path: receipt.source_path }), /POST \/lifecycle\/add/);
    assert.equal((await f.ledger()).calls, callsBefore + 1);
    assert.equal((await f.ledger()).jobs[0].status, "governance_required");
    await x.recreate().recover();
    const repeated = await f.recovery.fulfillOwnerDecision({ projectId: "P", ticketId: "TASK" });
    assert.equal(repeated.reason, "contract_revision_required");
    assert.equal((await x.plans.list()).length, 1);
    assert.equal(f.base.invocations, 1);
    assert.equal(f.base.integrations, 0);
    assert.equal(f.base.statusStore.get("TASK").details.execution_id, "EXEC");
    assert.equal(f.base.events.filter((event) => event.type === "task.blocker.owner_decision_required").length, 1);
    const job = (await f.ledger()).jobs[0];
    const prepare = createBlockerGovernanceHandoff({ plans: x.plans, fileService: x.planFiles, projectId: "P" });
    assert.equal((await prepare({ job, plan: { content: {} } })).sha256, receipt.sha256, "Notification retry must reuse the same canonical draft");
    await assert.rejects(prepare({ job: { ...job, request: { ...job.request, project_id: "OTHER" } }, plan: { content: {} } }), /different project/);
  } finally { await x.close(); }
});

test("legacy owner_decided checkpoints recover AM without clearing history or beginning a new execution", async () => {
  const x = await fixture();
  try {
    const { f } = x;
    const cp = await f.base.checkpoints.load("TASK");
    const decision = { decision_id: "BLOCKER-DECISION-LEGACY", actor: "OWNER", option_id: "http", job_id: cp.blocker_recovery.job_id };
    await f.base.checkpoints.save({ ...cp, status: "in_progress", failure: undefined, phase: "owner_decided", blocker_owner_decisions: [decision], blocker_recovery: { ...cp.blocker_recovery, status: "owner_decided", owner_decision: decision } });
    const current = f.base.statusStore.get("TASK");
    f.base.statusStore.updateStatus("TASK", "pending", { ...current.details, owner_decision: decision }, { expectedVersion: current.version, expectedExecutionId: "EXEC" });
    await x.recreate().recover();
    const resumed = await f.base.checkpoints.load("TASK");
    assert.equal(resumed.failure.at, cp.failure.at);
    assert.equal(resumed.status, "blocked");
    assert.deepEqual(resumed.blocker_owner_decisions, [decision]);
    await f.recovery.tick(); await f.recovery.tick();
    assert.equal((await f.base.checkpoints.load("TASK")).blocker_recovery.status, "governance_required");
    assert.equal(f.base.invocations, 1);
  } finally { await x.close(); }
});

test("provider failure or a repeated owner vote becomes technical reconciliation without relaunching Coder", async () => {
  for (const options of [{ fail: true }, { repeatedVote: true }]) {
    const x = await fixture(options);
    try {
      await x.service.decide({ requestedProjectId: "P", ticketId: "TASK", actor: "OWNER", optionId: "http" });
      await x.f.recovery.tick(); await x.f.recovery.tick();
      assert.equal((await x.f.base.checkpoints.load("TASK")).blocker_recovery.status, "reconciliation_required");
      assert.equal(x.f.base.invocations, 1);
      assert.equal(x.f.base.events.filter((event) => event.type === "task.blocker.owner_decision_required").length, 1);
      assert.equal(x.plans.list().length, 0);
    } finally { await x.close(); }
  }
});

test("changed execution, approval or source cannot fulfill a parked owner choice", async () => {
  for (const mutation of ["staleSource", "replaceExecution", "revokePlan"]) {
    const x = await fixture();
    try {
      const cp = await x.f.base.checkpoints.load("TASK");
      await x.f.base.checkpoints.save({ ...cp, blocker_owner_decisions: [{ decision_id: "BLOCKER-DECISION-OLD", actor: "OWNER", option_id: "http" }] });
      x.f.base[mutation]();
      await assert.rejects(x.f.recovery.fulfillOwnerDecision({ projectId: "P", ticketId: "TASK" }));
      assert.equal(x.f.base.invocations, 1);
      assert.equal(x.plans.list().length, 0);
    } finally { await x.close(); }
  }
});

test("RUN including fresh cannot bypass AM/governance or replace the original execution", async () => {
  const x = await fixture();
  try {
    const { f } = x;
    await x.service.decide({ requestedProjectId: "P", ticketId: "TASK", actor: "OWNER", optionId: "http" });
    await f.recovery.tick(); await f.recovery.tick();
    const dispatch = createTicketRunDispatch({ disposition: { get: async () => null }, intake: { open: async () => ({ ticket: f.ticket }) },
      sprintRegistry: f.base.registry, ticketStatusStore: f.base.statusStore, checkpoints: f.base.checkpoints, blockerRecovery: f.recovery,
      dispatchTask: async () => assert.fail("Coder must remain parked") });
    assert.equal((await dispatch({ projectId: "P", ticketId: "TASK", fresh: true })).reason, "contract_revision_required");
    assert.equal(f.base.invocations, 1);
  } finally { await x.close(); }
});

test("draft evidence is checked against live source and cannot grant execution authority", async () => {
  const x = await fixture();
  try {
    await x.service.decide({ requestedProjectId: "P", ticketId: "TASK", actor: "OWNER", optionId: "http" });
    await x.f.recovery.tick();
    const job = x.job();
    const value = (await x.f.ledger()).jobs[0].resolution;
    const basis = { job, plan: { content: {} }, fileService: x.f.base.fileService, projectRoot: x.f.base.workspace.projectRoot };
    for (const draft of [{ ...value.contract_draft, evidence: [{ ...x.f.evidence, sha256: "0".repeat(64) }] },
      { ...value.contract_draft, evidence: [{ path: "../secret", sha256: x.f.evidence.sha256 }] }]) {
      await assert.rejects(validateBlockerDisposition({ ...value, contract_draft: draft }, basis));
    }
    await assert.rejects(validateBlockerDisposition(value, { ...basis, job: { ...job, stage: "sprint_leader" } }));
    await assert.rejects(validateBlockerDisposition(value, { ...basis, job: { ...job, fulfillment_decision_id: null } }));
    await assert.rejects(validateBlockerDisposition({ ...value, action: "resolved" }, basis));
  } finally { await x.close(); }
});

test("source changed after AM completion goes to reconciliation instead of a publication retry loop", async () => {
  const x = await fixture();
  try {
    await x.service.decide({ requestedProjectId: "P", ticketId: "TASK", actor: "OWNER", optionId: "http" });
    await x.f.recovery.tick();
    await x.f.base.fileService.atomicWrite({ path: x.f.evidence.path, content: "export const changed = true;\n", replace: true });
    await x.f.recovery.tick(); await x.f.recovery.tick();
    assert.equal((await x.f.ledger()).jobs[0].status, "reconciliation_required");
    assert.equal((await x.f.base.checkpoints.load("TASK")).blocker_recovery.status, "reconciliation_required");
    assert.equal(x.plans.list().length, 0);
    assert.equal(x.f.base.invocations, 1);
  } finally { await x.close(); }
});

test("unavailable governance persistence is reported once as technical reconciliation", async () => {
  const x = await fixture();
  try {
    await x.service.decide({ requestedProjectId: "P", ticketId: "TASK", actor: "OWNER", optionId: "http" });
    x.f.recreate({ plans: undefined, planFileService: undefined });
    await x.f.recovery.tick(); await x.f.recovery.tick(); await x.f.recovery.tick();
    assert.equal((await x.f.ledger()).jobs[0].status, "reconciliation_required");
    assert.match((await x.f.base.checkpoints.load("TASK")).blocker_recovery.last_error, /persistence is unavailable/);
    assert.equal(x.f.base.invocations, 1);
  } finally { await x.close(); }
});

test("publication failure retains the indexed contract receipt across restart without another owner vote", async () => {
  const x = await fixture();
  try {
    await x.service.decide({ requestedProjectId: "P", ticketId: "TASK", actor: "OWNER", optionId: "http" });
    const publish = x.f.base.eventBus.publish;
    x.f.base.eventBus.publish = async (event) => {
      if (event.event_id?.startsWith("BLOCKER-GOVERNANCE-")) throw new Error("Event delivery unavailable");
      return publish(event);
    };
    await x.f.recovery.tick(); await x.f.recovery.tick();
    await x.recreate().tick();
    const checkpoint = await x.f.base.checkpoints.load("TASK");
    assert.equal(checkpoint.blocker_recovery.status, "reconciliation_required");
    const handoff = checkpoint.blocker_recovery.governance_handoff;
    assert.ok(handoff.plan_id);
    assert.equal((await x.plans.getRevision({ planId: handoff.plan_id, revision: handoff.revision })).status, "awaiting_human_approval");
    assert.equal(x.plans.list().length, 1);
    assert.equal(x.f.base.invocations, 1);
  } finally { await x.close(); }
});
