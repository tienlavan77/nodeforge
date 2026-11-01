// Verifies historical contract failures reach AM once without changing the
// approved evidence or routing unrelated source conflicts away from their owner.
import assert from "node:assert/strict";
import test from "node:test";
import { assignContractConsultation } from "../../src/modules/supervisor/blocker/blocker-contract-consultation.js";

test("contract baseline mismatch assigns AM once and preserves approval evidence", () => {
  const evidence = [{ path: "contract.js", sha256: "a".repeat(64) }];
  const job = { id: "JOB", stage: "sprint_leader", reason_code: "CONTRACT_DECISION_REQUIRED", history: [],
    request: { project_id: "P", task_id: "T", payload: { execution_id: "RUN" }, ticket: { execution_policy: { contract_evidence: evidence } } } };
  const feedback = [{ path: "/contract_evidence", reason: "contract_baseline_mismatch" }];
  assert.equal(assignContractConsultation(job, feedback, 100), true);
  assert.equal(job.stage, "architecture_manager");
  assert.equal(job.status, "pending");
  assert.equal(job.resolution.action, "architecture_required");
  assert.deepEqual(job.request.ticket.execution_policy.contract_evidence, evidence);
  job.stage = "sprint_leader";
  assert.equal(assignContractConsultation(job, feedback, 200), false);
  assert.equal(job.authority_consultations.length, 1);
});

test("unrelated source conflicts do not trigger a contract consultation", () => {
  const job = { stage: "sprint_leader", reason_code: "SCOPE_CONFLICT" };
  assert.equal(assignContractConsultation(job, [{ path: "/contract_evidence", reason: "contract_baseline_mismatch" }], 100), false);
  assert.equal(assignContractConsultation({ ...job, reason_code: "CONTRACT_DECISION_REQUIRED" }, [{ path: "/source", reason: "source_drift" }], 100), false);
});

test("truncated SL response on an undelegated contract or admission blocker fast-routes to AM", () => {
  const job = { id: "JOB-TRUNC", stage: "sprint_leader", reason_code: "CONTRACT_DECISION_REQUIRED", message: "Contract endpoint missing", history: [],
    request: { project_id: "P", task_id: "T", payload: { execution_id: "RUN" }, ticket: {} } };
  const feedback = [{ path: "/", reason: "max_output_tokens", message: "Truncated at max_output_tokens." }];
  assert.equal(assignContractConsultation(job, feedback, 300), true);
  assert.equal(job.stage, "architecture_manager");
  assert.equal(job.status, "pending");
  assert.equal(job.resolution.action, "architecture_required");
  assert.match(job.consultation_request.question, /Contract endpoint missing/);
});
