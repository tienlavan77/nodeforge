/** Keeps approved technical decisions separate from execution services. Once AM
 * answers SL, Node coordinates the retained Coder handoff without creating an
 * additional admission workflow or converting technical advice into tool approval. */
import { readBlockerContractDelegation } from "./blocker-contract-delegation.js";

/** Makes the current coordination rule explicit for resumed SDK sessions that
 * may still remember obsolete instructions to request a Node admission step. */
export function blockerHandoffPrompt() {
  return "CURRENT HANDOFF POLICY: There is no separate Node admission step, service request or approval prerequisite after a validated AM decision. AM answers SL; SL returns actionable implementation and verification guidance to Coder at its retained checkpoint. Consume the settled decision instead of asking Node to admit it, waiting for an unavailable admission tool, or repeating the same SL/AM consultation. SL submits its resolved disposition for normal validation; do not wait for acceptance of a disposition that has not been submitted. This dispatch supplies coordination only. File permissions, fresh checksums, claims and actual tool approval still run at each operation. A historical denied operation remains denied: if a concrete tool boundary is unresolved, identify that original receipt and the precise remaining decision for SL, rather than inventing another internal admission task. Only a demonstrated decision outside approved authority or material structure risk goes through AM to Owner.";
}

/** Identifies a retained wrong-role action from structured validation receipts,
 * so coordination can explain the exact correction without inferring authority
 * from the agent's narrative or treating a schema error as a tool denial. */
export function blockerHandoffCorrection(job) {
  const attempts = job.disposition_attempts ?? [];
  const rejected = attempts.findLast((entry) => entry.stage === "sprint_leader" && entry.status === "rejected");
  if (!rejected?.validation_errors?.some((entry) => ["role_not_authorized", "role_action_mismatch"].includes(entry.reason))) return null;
  let value;
  try { value = JSON.parse(rejected.response?.text ?? "null"); }
  catch (error) { return { response_parse_error: error.message }; }
  const decision = value?.payload?.decision ?? value;
  if (decision?.action !== "sprint_required") return null;
  for (const entry of attempts.slice(attempts.indexOf(rejected) + 1)) {
    if (entry.stage !== "sprint_leader" || entry.status !== "accepted") continue;
    let accepted;
    try { accepted = JSON.parse(entry.response?.text ?? "null"); }
    catch (error) { return { response_parse_error: error.message }; }
    if ((accepted?.payload?.decision ?? accepted)?.action === "resolved") return null;
  }
  return { rejected_at: rejected.received_at, action: decision.action, authority_scope: decision.authority_scope ?? null,
    validation_errors: rejected.validation_errors, expected_action: "resolved", expected_scope: "sprint",
    instruction: "The rejected action sprint_required belongs to AM, even when authority_scope=sprint. This did not reject Sprint authority or deny a tool operation. SL must submit resolved with its Sprint authority reference and remaining Coder steps; no separate pre-validation receipt or Node admission service is required. Actual disposition and tool validation remain enforced." };
}

/** Archives an obsolete pending request after AM has answered, without forging
 * an Owner verdict, deleting the actual denial receipt or authorizing a tool. */
export function completeBlockerAdmissionWait(job, now) {
  const request = job.execution_admission;
  if (!request || request.decision || request.status === "retained_for_audit") return;
  job.history.push({ stage: "sprint_leader", event: "execution_admission_wait_removed", completed_at: now, previous_request: request });
  job.execution_admission = { ...request, status: "retained_for_audit", coordination_completed_at: now };
}

/** Reopens only old admission-coordination stops backed by an authenticated AM
 * answer. The existing poller rechecks Stop, execution and plan identity before
 * SL receives a fresh handoff request; no Coder operation is replayed here. */
export function createBlockerHandoffRefresh({ inspect, fileService, clock = Date.now, projectLogger = () => {} }) {
  return async (job) => {
    const correction = blockerHandoffCorrection(job);
    const legacyCorrection = job.handoff_policy === "am-handoff-v1" && correction?.expected_action === "resolved";
    const legacyWait = job.resolution?.reconciliation?.kind === "execution_admission"
      || job.technical_reconciliation?.work?.kind === "execution_admission"
      || job.validation_feedback?.some((entry) => entry.reason?.startsWith("execution_admission_") || entry.reason === "EXECUTION_ADMISSION_REQUIRED");
    if ((!legacyWait && !legacyCorrection) || job.handoff_policy === "am-handoff-v2" || job.execution_admission?.decision) return false;
    let authority, delegation, contracts;
    try {
      authority = await inspect(job);
      if (!authority) return false;
      ({ delegation, contracts } = await readBlockerContractDelegation({ job, checkpoint: authority.checkpoint, fileService, architecture: authority.architecture }));
    } catch (error) {
      projectLogger({ event_name: "supervisor.blocker_handoff_invalid", level: "warn", status: "blocked", task_id: job.request.task_id,
        message: "Retained AM handoff could not be authenticated; checkpoint preserved.", payload: { job_id: job.id, code: error.code, error: error.message } });
      return false;
    }
    const current = job.architecture_response?.execution_id === job.request.payload.execution_id
      ? job.architecture_response.disposition : delegation;
    if (["owner_required", "governance_required"].includes(current?.action)) return false;
    const answer = current?.action === "resolved" ? current : legacyCorrection ? delegation : current;
    if (answer?.action !== "resolved" || answer.authority_scope !== "architecture") return false;
    job.history.push({ stage: "sprint_leader", event: "am_handoff_restored", completed_at: clock(),
      previous_resolution: job.resolution ?? null, previous_feedback: job.validation_feedback ?? [], correction,
      previous_architecture_response: job.architecture_response ?? null, previous_technical_reconciliation: job.technical_reconciliation ?? null,
      previous_waiting_assignments: job.waiting_assignments ?? [] });
    completeBlockerAdmissionWait(job, clock());
    job.handoff_policy = "am-handoff-v2";
    job.stage = "sprint_leader";
    if (legacyCorrection && answer === delegation) {
      const receipt = contracts.findLast((entry) => entry.record.disposition === delegation);
      job.architecture_response = { disposition: delegation, execution_id: job.request.payload.execution_id,
        answered_at: Date.parse(receipt.record.validated_at), actor: receipt.record.actor,
        retained_receipt: { path: receipt.path, sha256: receipt.sha256 } };
      job.sprint_delegation = delegation;
    }
    delete job.resolution;
    delete job.validation_feedback;
    delete job.technical_reconciliation;
    job.waiting_assignments = [];
    job.coordination_feedback = `${blockerHandoffPrompt()}${legacyCorrection ? `\nRETAINED HANDOFF CORRECTION: ${JSON.stringify(correction)}` : ""}`;
    projectLogger({ event_name: "supervisor.blocker_handoff_restored", level: "info", status: "pending", task_id: job.request.task_id,
      message: "Obsolete Node admission wait removed; settled AM decision returned to SL for retained Coder handoff.", payload: { job_id: job.id } });
    return true;
  };
}
