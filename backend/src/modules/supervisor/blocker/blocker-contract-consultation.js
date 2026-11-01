// Assigns historical contract approval mismatches to Architecture instead of
// repeatedly asking Sprint Leader to repair evidence it cannot authorize.
import { assignAuthorityConsultation } from "./blocker-authority-consultation.js";
import { requiresBlockerAdmission, requiresBlockerContract } from "./blocker-failure-classification.js";

/** Routes a validated contract-baseline failure or truncated AM-bound SL turn
 * into one execution-bound AM consultation. Existing approval bytes and Coder
 * checkpoints remain intact; Architecture decides using normal evidence gates. */
export function assignContractConsultation(job, feedback, now) {
  if (job.stage !== "sprint_leader") return false;
  const baselineMismatch = job.reason_code === "CONTRACT_DECISION_REQUIRED"
    && feedback?.some((entry) => entry.path === "/contract_evidence"
      && ["contract_baseline_mismatch", "contract_baseline_missing"].includes(entry.reason));
  const truncatedAuthority = feedback?.some((entry) => ["max_output_tokens", "response_truncated", "SDK_MAX_OUTPUT_TOKENS"].includes(entry.reason))
    && !job.architecture_response && !job.sprint_delegation && !job.ticket_progress?.architecture_decision
    && (requiresBlockerContract(job) || requiresBlockerAdmission(job));
  if (!baselineMismatch && !truncatedAuthority) return false;
  const evidence = job.request?.ticket?.execution_policy?.contract_evidence ?? [];
  const question = job.coder_consultation?.question || job.message || `Resolve ${job.reason_code} for ${job.request?.task_id ?? "this ticket"}.`;
  return assignAuthorityConsultation(job, {
    action: "reconciliation_required",
    summary: baselineMismatch
      ? "Architecture must reconcile the approved contract with its historical baseline."
      : `Architecture decision required for ${job.reason_code}: ${question.slice(0, 300)}`,
    guidance: baselineMismatch
      ? `Inspect the declared contract evidence and Node validation: ${JSON.stringify({ evidence, feedback })}. Decide the valid contract prerequisite within approved authority and return actionable guidance to SL. Do not substitute current file checksums for historical approval, weaken source validation, or dispatch Coder before reconciliation.`
      : `Resolve the contract or authority prerequisite directly for SL: ${question}. Decide within the approved Architecture/Sprint plan and return actionable guidance to SL without dispatching Coder.`,
    evidence
  }, now);
}
