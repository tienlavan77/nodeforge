/** Reproduces a legacy independent-report wait that was incorrectly assigned
 * to Coder and then parked behind a deduplicated AM answer. Coordination uses
 * typed ownership and factual capabilities, never question keyword matching. */
import assert from "node:assert/strict";
import test from "node:test";
import { assignAuthorityConsultation } from "../../src/modules/supervisor/blocker-authority-consultation.js";
import { returnArchitectureResponse } from "../../src/modules/supervisor/blocker-architecture-response.js";
import { createBlockerReconciliationRefresh } from "../../src/modules/supervisor/blocker-reconciliation-refresh.js";
import { assignWaitingWork, waitingAssignments } from "../../src/modules/supervisor/blocker-waiting-work.js";
import { validateTechnicalReconciliation } from "../../src/modules/supervisor/blocker-technical-reconciliation.js";
import { blockerExchangePrompt } from "../../src/modules/supervisor/blocker-exchange-prompt.js";
import { blockerExchangeRequest } from "../../src/modules/supervisor/blocker-agent-exchange.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { currentBlockerCoordination } from "../../src/modules/supervisor/blocker-coordination-evidence.js";

const wait = { action: "reconciliation_required", summary: "Independent report is unavailable.", guidance: "Preserve the committed behavior and existing diagnostic denial.",
  reconciliation: { kind: "source_revision", prerequisite: "Independent attribution evidence.", completed_checks: ["Coder cannot author an independent report."],
    next_check: "Identify how to obtain the report.", waiting_for: ["Provide an independent report."] } };

/** Supplies old answered coordination records and a completed Coder assignment
 * without implying that formal review, acceptance or evidence production ran. */
function parked() {
  return { id: "J", stage: "sprint_leader", status: "reconciliation_required", outcome_reason: "technical_reconciliation_waiting_for_evidence", history: [],
    reason_code: "SCOPE_CONFLICT", resolution: structuredClone(wait), request: { project_id: "P", task_id: "T", payload: { execution_id: "E" }, ticket: {} },
    architecture_response: { execution_id: "E", disposition: structuredClone(wait) },
    authority_consultations: [{ identity: "old-request", response_identity: "old-answer", status: "answered" }],
    waiting_work_history: [{ fingerprint: "completed-preparation", owner: "coder", kind: "source_revision", status: "answered" }],
    ticket_progress: { review_status: { status: "not_started", report_status: "not_created" } } };
}

test("legacy questions never infer Coder or AM ownership from a kind or their wording", () => {
  for (const kind of ["source_revision", "technical_design", "tooling"]) {
    const job = parked(), value = { ...wait, reconciliation: { ...wait.reconciliation, kind } };
    assert.equal(waitingAssignments(value.reconciliation)[0].owner, "unassigned");
    assert.equal(assignWaitingWork(job, value, 1), false);
    assert.equal(job.coder_exchange, undefined);
    assert.equal(job.stage, "sprint_leader");
  }
});

test("parked legacy wait reaches AM once with new coordination facts and deduplicates paraphrases across restart", async () => {
  const job = parked(), original = structuredClone(job);
  const refresh = createBlockerReconciliationRefresh({ inspect: async () => ({ workspace: {} }) });
  assert.equal(await refresh(job), true);
  assert.equal(job.stage, "architecture_manager");
  assert.equal(job.authority_consultations.length, 2);
  assert.equal(job.authority_consultations[1].coordination_evidence.independent_reviewer_preparation, "supported");
  assert.equal(job.authority_consultations[1].coordination_evidence.formal_review.status, "not_started");
  assert.deepEqual(job.request, original.request);
  assert.deepEqual(job.architecture_response, original.architecture_response);
  returnArchitectureResponse(job, wait, 2);
  const restarted = structuredClone(job);
  assert.equal(assignAuthorityConsultation(restarted, { ...wait, summary: "Paraphrased unavailable report." }, 3), false);
  assert.equal(restarted.authority_consultations.length, 2);
});

test("capability-bound AM response needs explicit ownership while old stored strings remain readable", () => {
  const job = parked();
  validateTechnicalReconciliation(wait, job);
  assignAuthorityConsultation(job, wait, 1);
  assert.throws(() => validateTechnicalReconciliation(wait, job), (error) => error.validation_errors[0].reason === "waiting_owner_required");
  const explicit = { ...wait, reconciliation: { ...wait.reconciliation,
    waiting_for: [{ owner: "coder", operation: "inspect", question: "Read source hashes without claiming independent Reviewer authorship." }] } };
  assert.doesNotThrow(() => validateTechnicalReconciliation(explicit, job));
});

test("an unavailable or replaced execution cannot reopen the legacy consultation", async () => {
  const job = parked(), original = structuredClone(job);
  const refresh = createBlockerReconciliationRefresh({ inspect: async () => null });
  assert.equal(await refresh(job), false);
  assert.deepEqual(job, original);
});

test("a legacy AM answer without consultation history still receives the new ownership capability evidence once", () => {
  const job = parked();
  delete job.authority_consultations;
  assert.equal(assignAuthorityConsultation(job, wait, 1), true);
  returnArchitectureResponse(job, wait, 2);
  assert.equal(assignAuthorityConsultation(structuredClone(job), wait, 3), false);
});

test("shared provider prompt delivers capabilities alongside the focused AM question", () => {
  const job = parked();
  assignAuthorityConsultation(job, wait, 1);
  const request = blockerExchangeRequest(job, { role: "architecture_manager", agent_id: "AM" }, { list: () => [{ enabled: true, agent_id: "SL" }] });
  const prompt = blockerExchangePrompt({ request, job, context: { summary: "" }, tools: { definitions: [] } });
  assert.match(prompt, /NODE COORDINATION CAPABILITIES/);
  assert.match(prompt, /independent_reviewer_preparation/);
  assert.match(prompt, /independent_reviewer_preparation.*supported/);
  assert.match(prompt, /Choose an executable evidence handoff/);
});

test("AM prompt uses live capabilities even when its retained assignment says Reviewer is unsupported", () => {
  const job = parked();
  assignAuthorityConsultation(job, wait, 1);
  const retained = job.authority_consultations.at(-1).coordination_evidence;
  retained.independent_reviewer_preparation = "not_supported";
  retained.read_only_preparation_roles = ["coder", "architecture_manager"];
  const request = blockerExchangeRequest(job, { role: "architecture_manager", agent_id: "AM" }, { list: () => [{ enabled: true, agent_id: "SL" }] });
  const prompt = blockerExchangePrompt({ request, job, context: { summary: "" }, tools: { definitions: [] } });
  assert.match(prompt, /"independent_reviewer_preparation":"supported"/);
  assert.doesNotMatch(prompt, /"independent_reviewer_preparation":"not_supported"/);
  assert.equal(retained.independent_reviewer_preparation, "not_supported");
});

test("a parked AM syntax correction wakes once after capability changes and preserves the question and failed responses", async () => {
  const job = parked();
  assignAuthorityConsultation(job, wait, 1);
  Object.assign(job, { status: "reconciliation_required", outcome_reason: "disposition_correction_no_progress",
    validation_feedback: [{ path: "/", reason: "json_invalid" }], disposition_attempts: [{ response: { text: "{incomplete" } }] });
  job.authority_consultations.at(-1).coordination_evidence.independent_reviewer_preparation = "not_supported";
  const before = structuredClone(job), events = [];
  const refresh = createBlockerReconciliationRefresh({ inspect: async () => ({ workspace: {} }), projectLogger: (event) => events.push(event) });
  assert.equal(await refresh(job), true);
  assert.equal(job.stage, "architecture_manager");
  assert.equal(job.resolution.action, "architecture_required");
  assert.equal(job.validation_feedback, undefined);
  assert.deepEqual(job.consultation_request, before.consultation_request);
  assert.deepEqual(job.disposition_attempts, before.disposition_attempts);
  assert.equal(currentBlockerCoordination(job).independent_reviewer_preparation, "supported");
  assert.equal(events[0].event_name, "supervisor.blocker_coordination_refreshed");
  assert.equal(await refresh(structuredClone(job)), false);
  for (const patch of [{ status: "cancelled" }, { outcome_reason: "BLOCKER_PROVIDER_UNKNOWN" }]) {
    const stopped = { ...structuredClone(before), ...patch };
    assert.equal(await refresh(stopped), false);
    assert.deepEqual(stopped, { ...before, ...patch });
  }
  const stale = structuredClone(before);
  assert.equal(await createBlockerReconciliationRefresh({ inspect: async () => null })(stale), false);
  assert.deepEqual(stale, before);
});

test("actual recovery dispatches AM then SL and preserves the Coder checkpoint until the resolved handoff", async () => {
  const result = { findings: ["Available source evidence settles the narrow technical question."], implementation_steps: ["Continue the approved ticket."],
    verification_steps: ["Run the focused handler check."], admission: { status: "within_existing_permissions", rationale: "No new permission or denied execution is needed." } };
  const f = await blockerRecoveryFixture({ investigate: async (_job, resolution) => ({ ...resolution, technical_result: result }) });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const checkpoint = await f.base.checkpoints.load("TASK");
    await f.base.store.withLock("blocker.recovery", async () => {
      const ledger = await f.ledger(), current = ledger.jobs[0], legacy = parked();
      Object.assign(current, { resolution: legacy.resolution, status: legacy.status, outcome_reason: legacy.outcome_reason,
        authority_consultations: legacy.authority_consultations, waiting_work_history: legacy.waiting_work_history, ticket_progress: legacy.ticket_progress,
        architecture_response: { ...legacy.architecture_response, execution_id: current.request.payload.execution_id } });
      await f.base.store.save("blocker.recovery", ledger);
    });
    await f.recovery.tick();
    assert.deepEqual(f.calls, ["architecture_manager"]);
    assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, checkpoint.last_completed_turn);
    await f.recovery.tick();
    assert.deepEqual(f.calls, ["architecture_manager", "sprint_leader"]);
    assert.equal(f.base.invocations, 1);
    await f.recovery.tick();
    assert.equal(f.base.invocations, 2);
  } finally { await f.close(); }
});
