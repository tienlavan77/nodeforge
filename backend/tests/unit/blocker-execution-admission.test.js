// Verifies denial review uses authenticated exact evidence and never authorizes a silent retry.
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockerFailureClassification } from "../../src/modules/supervisor/blocker-failure-classification.js";
import { createBlockerAdmission } from "../../src/modules/supervisor/blocker-execution-admission.js";
import { scheduleTechnicalReconciliation } from "../../src/modules/supervisor/blocker-technical-reconciliation.js";
import { routeTicketReview } from "../../src/transport/http/forge-v1-ticket-review-routes.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";

const technical = { action: "reconciliation_required", summary: "An existing GET alias was denied as a new identifier.",
  guidance: "Preserve the existing alias on GET collection only; no other method or route.", evidence: [{ path: "routes.js" }],
  reconciliation: { kind: "execution_admission", prerequisite: "Reconcile the original denial.", completed_checks: ["GET collection already accepts the alias."], next_check: "Review original denial and source.", waiting_for: ["Original tool admission must be reconciled or a materially safer alternative found."] } };

// Provides a persisted recovery job and mutable source to exercise stale review and restart behavior.
async function fixture() {
  const files = new Map([["context.js", "old resolver"], ["routes.js", "GET accepts alias"]]);
  const job = { id: "J", status: "reconciliation_required", stage: "sprint_leader", failure_at: "2026-10-19T03:00:00Z", history: [],
    request: { project_id: "P", task_id: "T", payload: { execution_id: "E", sprint_basis: { version: 1 } }, execution_context: { base_sha: "base" } }, resolution: technical };
  let ledger = { project_id: "P", task_id: "T", execution_id: "E", jobs: [job] };
  let launches = 0;
  const store = { withLock: async (_name, fn) => fn(), list: async () => [structuredClone(ledger)], save: async (_name, value) => { ledger = structuredClone(value); } };
  const inspect = async () => ({ workspace: { fileService: { readFile: async ({ path }) => files.get(path) } } });
  const receipt = { event_id: "DENIAL", tool: "edit_diff", arguments: { path: "context.js", replacement: "alias proposal" },
    error: { message: "This action was rejected due to unacceptable risk. New alternate identifier. The agent must not attempt a workaround." } };
  const options = { store, inspect, clock: () => 123, readFailureEvidence: async () => ({ status: "captured", receipts: [receipt] }), projectLogger: () => { launches += 0; } };
  const service = createBlockerAdmission(options);
  const request = (await service.prepare(technical, job)).execution_admission_request;
  ledger.jobs[0].execution_admission = request;
  const call = (review, actor = "OWNER", method = "POST", projectId = "P") => service.access({ projectId, ticketId: "T", actor, admission: { method, review } });
  const allow = { verdict: "allow", request_sha256: request.sha256, reason: "Existing contract confirmed.", guidance: "GET collection alias only; no permission or scope expansion." };
  return { service, options, files, job, receipt, request, call, allow, ledger: () => structuredClone(ledger), launches: () => launches };
}

test("Node retains original denial evidence without adding a separate Owner gate", async () => {
  const f = await fixture();
  assert.equal(f.request.receipts[0].event_id, "DENIAL");
  assert.equal(f.request.source.length, 2);
  assert.equal(f.request.sha256.length, 64);
  scheduleTechnicalReconciliation(f.job, { ...technical, execution_admission_request: f.request }, 123);
  assert.equal(f.job.status, "pending");
  assert.equal(f.job.stage, "architecture_manager");
  assert.equal(f.job.outcome_reason, undefined);
  await assert.rejects(f.service.assertAllowed(f.job), { code: "EXECUTION_ADMISSION_REQUIRED" });
});

test("a journal conflict misclassified as approval denial returns correctable SL feedback instead of parking for missing admission evidence", async () => {
  const f = await fixture();
  const service = createBlockerAdmission({ ...f.options, readFailureEvidence: async () => ({ status: "captured", receipts: [
    { tool: "commit_changes", error: { code: "TICKET_BASELINE_CONFLICT", message: "Ticket before-state differs from every recorded ticket state: backend/scripts/control-api-http.mjs." } },
  ] }) });
  await assert.rejects(service.prepare(technical, f.job), (error) => {
    assert.equal(error.code, "BLOCKER_DISPOSITION_INVALID");
    assert.equal(error.retryable_disposition, true);
    assert.equal(error.validation_errors[0].reason, "execution_admission_misclassified");
    assert.match(error.message, /source_revision/);
    return true;
  });
});

test("a validated resolved handoff is not converted into mandatory Owner review", async () => {
  const f = await fixture();
  delete f.job.execution_admission;
  const result = await f.service.prepare({ action: "resolved", summary: "I believe this was already permitted.", guidance: technical.guidance, evidence: technical.evidence }, f.job);
  assert.equal(result.action, "resolved");
  assert.equal(result.execution_admission_request, undefined);
});

test("exact owner allow is durable and idempotent; restart retains it without launching Coder", async () => {
  const f = await fixture();
  const first = await f.call(f.allow);
  const second = await f.call(f.allow);
  assert.deepEqual(first, second);
  const recreated = createBlockerAdmission(f.options);
  await recreated.assertAllowed(f.ledger().jobs[0]);
  assert.equal(f.ledger().jobs[0].history.length, 1);
  assert.equal(f.ledger().jobs[0].status, "reconciliation_required");
  assert.equal(f.launches(), 0);
  await assert.rejects(f.call({ ...f.allow, verdict: "deny" }), { code: "EXECUTION_ADMISSION_DECISION_CONFLICT" });
});

test("wrong actor, project, request SHA and missing permitted guidance cannot approve", async () => {
  const f = await fixture();
  await assert.rejects(f.call(f.allow, ""), { code: "EXECUTION_ADMISSION_UNAUTHORIZED" });
  await assert.rejects(f.call(f.allow, "OWNER", "POST", "OTHER"), { code: "EXECUTION_ADMISSION_REQUIRED" });
  await assert.rejects(f.call({ ...f.allow, request_sha256: "0".repeat(64) }), { code: "EXECUTION_ADMISSION_IDENTITY_MISMATCH" });
  await assert.rejects(f.call({ ...f.allow, guidance: "" }), { code: "EXECUTION_ADMISSION_INPUT" });
  assert.equal(f.ledger().jobs[0].execution_admission.decision, undefined);
});

test("source drift refreshes the request and requires a new exact owner review", async () => {
  const f = await fixture();
  f.files.set("context.js", "changed by another operation");
  await assert.rejects(f.call(f.allow), { code: "EXECUTION_ADMISSION_SOURCE_CHANGED" });
  const fresh = (await f.call(undefined, "OWNER", "GET")).execution_admission;
  assert.notEqual(fresh.sha256, f.request.sha256);
  await assert.rejects(f.call(f.allow), { code: "EXECUTION_ADMISSION_IDENTITY_MISMATCH" });
  await f.call({ ...f.allow, request_sha256: fresh.sha256 });
  f.files.set("routes.js", "later source drift");
  await assert.rejects(f.service.assertAllowed(f.ledger().jobs[0]), { code: "EXECUTION_ADMISSION_SOURCE_CHANGED" });
});

test("owner deny and incomplete original evidence never permit a retry", async () => {
  const f = await fixture();
  await f.call({ ...f.allow, verdict: "deny" });
  await assert.rejects(f.service.assertAllowed(f.ledger().jobs[0]), { code: "EXECUTION_ADMISSION_REQUIRED" });
  const incomplete = createBlockerAdmission({ ...f.options, readFailureEvidence: async () => ({ status: "partial", receipts: [f.receipt] }) });
  await assert.rejects(incomplete.prepare(technical, f.job), { code: "EXECUTION_ADMISSION_EVIDENCE_REQUIRED" });
});

test("denied new-file creation records absence and detects later creation instead of throwing ENOENT", async () => {
  const f = await fixture();
  const options = { ...f.options, inspect: async () => ({ workspace: { fileService: { readFile: async ({ path }) => {
    if (!f.files.has(path)) throw Object.assign(new Error("Absent proposed file"), { code: "ENOENT" });
    return f.files.get(path);
  } } } }) };
  f.files.delete("context.js");
  const service = createBlockerAdmission(options);
  const prepared = await service.prepare(technical, f.job);
  assert.deepEqual(prepared.execution_admission_request.source.find((entry) => entry.path === "context.js"), { path: "context.js", sha256: null });
  const bound = { ...f.job, execution_admission: { ...prepared.execution_admission_request, decision: { verdict: "allow" } } };
  await service.assertAllowed(bound);
  f.files.set("context.js", "Unexpected file creation");
  await assert.rejects(service.assertAllowed(bound), { code: "EXECUTION_ADMISSION_SOURCE_CHANGED" });
  const broken = createBlockerAdmission({ ...f.options, inspect: async () => ({ workspace: { fileService: { readFile: async () => {
    throw Object.assign(new Error("Storage unavailable"), { code: "EIO" });
  } } } }) });
  await assert.rejects(broken.prepare(technical, f.job), { code: "EIO" });
});

test("legacy parked jobs get a bound request through authenticated inspection; obsolete executions cannot be reviewed", async () => {
  const f = await fixture();
  const legacyStore = { ...f.options.store, list: async () => {
    const ledger = f.ledger();
    delete ledger.jobs[0].execution_admission;
    return [ledger];
  } };
  const legacy = createBlockerAdmission({ ...f.options, store: legacyStore });
  const input = { projectId: "P", ticketId: "T", actor: "OWNER", admission: { method: "GET" } };
  const response = await legacy.access(input);
  assert.equal(response.execution_admission.sha256, f.request.sha256);
  assert.equal(f.ledger().jobs[0].execution_admission.status, "awaiting_architecture_review");
  const obsolete = createBlockerAdmission({ ...f.options, inspect: async () => null });
  await assert.rejects(obsolete.access(input), { code: "EXECUTION_ADMISSION_REQUIRED" });
});

test("removed admission HTTP endpoint does not expose owner decisions", async () => {
  const input = { method: "POST", parts: ["tickets", "T", "blocker-admission"], projectId: "P", body: { actor: "OWNER", verdict: "allow" } };
  assert.equal(await routeTicketReview(input), null);
  const router = createForgeV1Router({});
  await assert.rejects(router.route("POST", new URL("http://localhost/forge/v1/tickets/T/blocker-admission?project=P"), { headers: {} }, undefined, input.body), { statusCode: 404 });
});

test("production RUN resumes SL without Owner admission review and retains the original Coder checkpoint", async () => {
  let allowed = false;
  const f = await blockerRecoveryFixture({ recoveryOptions: { readFailureEvidence: async () => ({ status: "captured", receipts: [
    { event_id: "DENIED-EDIT", tool: "edit_diff", arguments: { path: "backend/src/handler.js", replacement: "proposal" },
      error: { message: "This action was rejected due to unacceptable risk. The agent must not attempt a workaround." } }
  ] }) }, investigate: async (_job, resolution) => allowed ? { ...resolution, technical_result: {
    findings: ["A materially safer alternative is available within existing permissions."], implementation_steps: ["Implement only the permitted alternative; do not retry the denied edit."],
    verification_steps: ["Run the approved handler checks."], admission: { status: "within_existing_permissions", rationale: "The proposed alternative stays within existing permissions; tool checks remain enforced." }
  } } : { ...technical, evidence: resolution.evidence } });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const retainedTurn = (await f.base.checkpoints.load("TASK")).last_completed_turn;
    for (let turn = 0; turn < 4; turn += 1) await f.recovery.tick();
    assert.equal((await f.ledger()).jobs[0].outcome_reason, "technical_reconciliation_waiting_for_evidence");
    f.recreate();
    for (let turn = 0; turn < 3; turn += 1) await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
    assert.equal(f.base.invocations, 1);
    allowed = true;
    const resumed = await f.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
    assert.equal(resumed.resumed_stage, "sprint_leader");
    assert.equal(resumed.resumed_from_turn, retainedTurn ?? 0);
    await f.recovery.tick(); await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager", "sprint_leader", "sprint_leader"]);
    assert.equal(f.base.invocations, 2);
    assert.equal(f.base.statusStore.get().details.execution_id, "EXEC");
    const checkpoint = await f.base.checkpoints.load("TASK");
    assert.equal(checkpoint.blocker_recovery.execution_admission.decision, undefined);
  } finally { await f.close(); }
});

test("denied fixture creation returns the AM answer to SL instead of failing on missing-file capture", async () => {
  const f = await blockerRecoveryFixture({ recoveryOptions: { readFailureEvidence: async () => ({ status: "captured", receipts: [
    { event_id: "NEW-FILE-DENIAL", tool: "write_diff", arguments: { path: "backend/tests/integration/not-created.js", content: "proposed fixture" },
      error: { message: "This action was rejected due to unacceptable risk. Approval provider HTTP 503 overload." } }
  ] }) }, investigate: async (job, resolution) => job.stage === "sprint_leader"
    ? job.architecture_response ? { ...technical, evidence: resolution.evidence } : { action: "architecture_required", summary: "Consult AM about the retained actual denial." }
    : { ...technical, evidence: resolution.evidence } });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.tick();
    await f.recovery.tick();
    const job = (await f.ledger()).jobs[0];
    assert.equal(job.stage, "sprint_leader");
    assert.equal(job.architecture_response.disposition.action, "reconciliation_required");
    assert.equal(job.execution_admission.source.find((entry) => entry.path.endsWith("not-created.js")).sha256, null);
    assert.notEqual(job.outcome_reason, "ENOENT");
    assert.equal(f.base.invocations, 1);
  } finally { await f.close(); }
});

// Returns incorrect permission escalation to SL for correction rather than parking a known verification fault.
test("verified technical receipts reject an invented execution-admission prerequisite with correctable feedback", async () => {
  const f = await fixture();
  delete f.job.execution_admission;
  f.job.reason_code = "ACCESS_REQUIRED";
  const readFailureEvidence = async () => ({ status: "captured", receipts: [{ tool: "report_done",
    error: { code: "VERIFY_RECOVERY_PENDING", message: "Verification still running." } }] });
  f.job.ticket_progress = { failure_classification: await createBlockerFailureClassification({ readFailureEvidence })(f.job, { projectRoot: "/project" }) };
  const service = createBlockerAdmission({ ...f.options, readFailureEvidence });
  await assert.rejects(service.prepare(technical, f.job), (error) => {
    assert.equal(error.code, "BLOCKER_DISPOSITION_INVALID");
    assert.equal(error.retryable_disposition, true);
    assert.equal(error.validation_errors[0].reason, "execution_admission_misclassified");
    assert.match(error.message, /ticket_progress.verification/);
    return true;
  });
});
