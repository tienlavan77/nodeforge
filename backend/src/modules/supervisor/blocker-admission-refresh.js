// Repairs legacy execution-admission waits using original Node receipts and the current
// Architecture review contract. Historical reports and decisions remain in the audit trail;
// this service assigns a new read-only consultation without granting execution permission.
import { createBlockerFailureEvidence } from "./blocker-failure-evidence.js";
import { isBlockerApprovalDenial } from "./blocker-approval-denial.js";
import { createBlockerAdmission } from "./blocker-execution-admission.js";
import { assignAuthorityConsultation } from "./blocker-authority-consultation.js";

const REVIEW_POLICY = "architecture-admission-v1";

// Rebinds obsolete Owner waits to authentic denial receipts before consulting AM exactly once.
// Explicit Owner decisions and current requests are immutable; stale execution authority prevents recovery.
export function createBlockerAdmissionRefresh({ inspect, clock = Date.now, projectLogger = () => {},
  readFailureEvidence = createBlockerFailureEvidence({ toolNames: null, requirePath: false }) }) {
  const admission = createBlockerAdmission({ inspect, clock, readFailureEvidence });
  return async (job) => {
    const previous = job.execution_admission;
    if (job.outcome_reason !== "technical_reconciliation_waiting_for_evidence" || !previous || previous.decision
      || previous.review_policy_version === REVIEW_POLICY || job.resolution?.reconciliation?.kind !== "execution_admission") return false;
    const authority = await inspect(job);
    if (!authority) return false;
    const evidence = await readFailureEvidence(job, authority.workspace.projectRoot ?? authority.workspace.path);
    if (evidence.status !== "captured") return false;
    const receipts = evidence.receipts.filter(isBlockerApprovalDenial);
    const question = "Compare the approved plan with the original attempted operation and its actual tool denial. Decide the permitted recovery and return it to SL. A pending admission request is Node review state, not an Owner prohibition. If only Owner can resolve a concrete boundary, return owner_required with that boundary and options; do not wait on this request as missing evidence.";
    const value = { action: "reconciliation_required", summary: "Reassess the retained admission using original receipts and the current Architecture review contract.",
      guidance: question, evidence: job.resolution.evidence,
      reconciliation: { kind: "execution_admission", prerequisite: "An Architecture decision grounded in the original tool operation and approved plan.",
        completed_checks: ["Node excluded Coder completion narratives from approval-denial evidence.",
          `Node found ${receipts.length} authentic denial receipt(s) in the retained execution; prior implementation and verification evidence remain available.`],
        next_check: question, waiting_for: [{ owner: "external", operation: "inspect", question }] } };
    const replacement = receipts.length ? (await admission.prepare(value, job)).execution_admission_request : null;
    job.history.push({ stage: "sprint_leader", event: "execution_admission_rebound", completed_at: clock(),
      previous_request: previous, previous_resolution: job.resolution, previous_architecture_response: job.architecture_response ?? null,
      previous_technical_reconciliation: job.technical_reconciliation ?? null, previous_waiting_assignments: job.waiting_assignments ?? [],
      receipt_ids: receipts.map((entry) => entry.event_id) });
    if (replacement) job.execution_admission = replacement;
    else delete job.execution_admission;
    job.admission_review_revision = REVIEW_POLICY;
    delete job.architecture_response;
    delete job.sprint_delegation;
    delete job.coordination_feedback;
    job.waiting_assignments = [];
    job.technical_reconciliation = { ...job.technical_reconciliation, work: value.reconciliation, assigned_role: "architecture_manager", max_rounds: null };
    job.stage = "sprint_leader";
    assignAuthorityConsultation(job, value, clock());
    projectLogger({ event_name: "supervisor.blocker_admission_rebound", level: "info", status: "pending", task_id: job.request.task_id,
      message: "Original denial receipts assigned to Architecture; the obsolete Owner wait and report-derived denial were archived. Coder checkpoint retained.",
      payload: { job_id: job.id, receipt_ids: receipts.map((entry) => entry.event_id), review_policy_version: REVIEW_POLICY } });
    return true;
  };
}
