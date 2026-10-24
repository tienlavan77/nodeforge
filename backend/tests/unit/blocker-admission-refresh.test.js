// Exercises report-versus-denial provenance, legacy admission recovery and restart safety.
// Recovery must deliver actual tool decisions to AM without reopening Coder or fabricating Owner approval.
import assert from "node:assert/strict";
import test from "node:test";
import { isBlockerApprovalDenial } from "../../src/modules/supervisor/blocker-approval-denial.js";
import { createBlockerAdmission } from "../../src/modules/supervisor/blocker-execution-admission.js";
import { createBlockerAdmissionRefresh } from "../../src/modules/supervisor/blocker-admission-refresh.js";
import { createBlockerReconciliationRefresh } from "../../src/modules/supervisor/blocker-reconciliation-refresh.js";
import { returnArchitectureResponse } from "../../src/modules/supervisor/blocker-architecture-response.js";
import { blockerExchangePrompt } from "../../src/modules/supervisor/blocker-exchange-prompt.js";

const report = { event_id: "REPORT", tool: "report_done", arguments: { status: "blocked" }, error: { code: "CODER_BLOCKED",
  message: "SECURITY_RISK: Preserve the retained approval denial; Coder cannot remove the denied gate." } };
const denial = { event_id: "DENIAL", tool: "edit_diff", arguments: { path: "backend/source.js", anchor: "old", replacement: "new" },
  error: { message: "This action was rejected due to unacceptable risk.\nReason: The proposed operation expands a permission boundary." } };

// Supplies distinct executions with a historical false admission and a real referenced tool denial.
function fixture(id = "T") {
  const job = { id, stage: "sprint_leader", status: "reconciliation_required", reason_code: "SECURITY_RISK",
    outcome_reason: "technical_reconciliation_waiting_for_evidence", failure_at: "2026-10-23T05:17:13Z", history: [],
    request: { task_id: id, project_id: "P", payload: { execution_id: `RUN-${id}` }, execution_context: {} },
    execution_admission: { status: "awaiting_owner_review", sha256: "false-report", receipts: [report] },
    architecture_response: { answered_at: Date.parse("2026-10-23T08:00:00Z"), execution_id: `RUN-${id}`,
      disposition: { action: "reconciliation_required", summary: "Await Owner review of the completion report." } },
    resolution: { action: "reconciliation_required", summary: "Await Owner review.", evidence: [{ path: "backend/source.js" }],
      reconciliation: { kind: "execution_admission", waiting_for: ["Await the existing request."] } } };
  const options = { inspect: async () => ({ workspace: { projectRoot: "/project", fileService: { readFile: async () => "current source" } } }),
    readFailureEvidence: async () => ({ status: "captured", receipts: [denial, report] }), clock: () => Date.parse("2026-10-23T09:30:00Z") };
  return { job, options };
}

test("a blocked completion report cannot establish approval authority through quoted denial prose", () => {
  assert.equal(isBlockerApprovalDenial(report), false);
  assert.equal(isBlockerApprovalDenial({ ...report, error: { code: "APPROVAL_DENIED", message: denial.error.message } }), false);
  assert.equal(isBlockerApprovalDenial({ tool: "read_file", error: { code: "FILE_ROLE_FORBIDDEN", message: "The approval was denied in an earlier report." } }), false);
  assert.equal(isBlockerApprovalDenial(denial), true);
  assert.equal(isBlockerApprovalDenial({ tool: "run_check", error: { code: "APPROVAL_DENIED" } }), true);
});

test("Node rejects admission manufactured from the Coder report and preserves the original error category", async () => {
  const { job, options } = fixture();
  const admission = createBlockerAdmission({ ...options, readFailureEvidence: async () => ({ status: "captured", receipts: [report] }) });
  await assert.rejects(admission.prepare(job.resolution, job), (error) => error.validation_errors?.[0].reason === "execution_admission_unsubstantiated");
});

test("automatic recovery cannot recreate admission; an explicit legacy review retains original receipts", async () => {
  for (const id of ["FIRST", "SECOND"]) {
    const { job, options } = fixture(id);
    const request = structuredClone(job.request);
    const previous = structuredClone(job.execution_admission);
    const before = structuredClone(job);
    assert.equal(await createBlockerReconciliationRefresh(options)(job), false);
    assert.deepEqual(job, before);
    const refresh = createBlockerAdmissionRefresh(options);
    assert.equal(await refresh(job), true);
    assert.equal(job.stage, "architecture_manager");
    assert.equal(job.status, "pending");
    assert.equal(job.resolution.action, "architecture_required");
    assert.deepEqual(job.request, request);
    assert.deepEqual(job.execution_admission.receipts, [denial]);
    assert.equal(job.execution_admission.status, "awaiting_architecture_review");
    assert.equal(job.execution_admission.decision, undefined);
    assert.deepEqual(job.history[0].previous_request, previous);
    assert.equal(job.architecture_response, undefined);
    assert.equal(job.coder_exchange, undefined);
    returnArchitectureResponse(job, { action: "reconciliation_required", summary: "Actual permission requires a concrete boundary decision." }, options.clock());
    job.outcome_reason = "technical_reconciliation_waiting_for_evidence";
    job.resolution = { action: "reconciliation_required", reconciliation: { kind: "execution_admission" } };
    assert.equal(await createBlockerAdmissionRefresh(options)(structuredClone(job)), false);
    assert.equal(job.authority_consultations.length, 1);
  }
});

test("report-only evidence is archived without creating another denial or permission grant", async () => {
  const { job, options } = fixture();
  options.readFailureEvidence = async () => ({ status: "captured", receipts: [report] });
  assert.equal(await createBlockerAdmissionRefresh(options)(job), true);
  assert.equal(job.execution_admission, undefined);
  assert.equal(job.stage, "architecture_manager");
  assert.deepEqual(job.history[0].previous_request.receipts, [report]);
});

test("the shared provider prompt receives the corrected admission instead of the obsolete Owner wait", async () => {
  const { job, options } = fixture();
  job.waiting_assignments = [{ owner: "external", question: "Await awaiting_owner_review." }];
  job.technical_reconciliation = { work: job.resolution.reconciliation };
  await createBlockerAdmissionRefresh(options)(job);
  assert.deepEqual(job.waiting_assignments, []);
  assert.equal(job.technical_reconciliation.assigned_role, "architecture_manager");
  assert.equal(job.technical_reconciliation.work.next_check, job.consultation_request.decision_needed);
  const prompt = blockerExchangePrompt({ job, context: { summary: "Read the original evidence context." }, tools: { definitions: [] },
    request: { kind: "consultation_request", recipient: { role: "architecture_manager" }, payload: job.consultation_request, subject: job.resolution.summary } });
  assert.match(prompt, /HISTORICAL TOOL DECISION EVIDENCE/);
  assert.match(prompt, /awaiting_architecture_review/);
  assert.match(prompt, /not an Owner prohibition or missing external evidence/);
  assert.match(prompt, /"event_id":"DENIAL","tool":"edit_diff"/);
  assert.doesNotMatch(prompt, /awaiting_owner_review|"event_id":"REPORT"/);
});

test("explicit Owner decisions, incomplete receipts, stale authority and unrelated waits stay unchanged", async () => {
  for (const kind of ["owner", "partial", "stale", "other_wait"]) {
    const { job, options } = fixture();
    if (kind === "owner") job.execution_admission.decision = { verdict: "deny", actor: "Owner" };
    if (kind === "partial") options.readFailureEvidence = async () => ({ status: "partial", receipts: [denial] });
    if (kind === "stale") options.inspect = async () => null;
    if (kind === "other_wait") job.resolution.reconciliation.kind = "dependency";
    const before = structuredClone(job);
    assert.equal(await createBlockerAdmissionRefresh(options)(job), false);
    assert.deepEqual(job, before);
  }
});
