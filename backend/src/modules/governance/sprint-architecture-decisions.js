// Transfers approved Architecture owner policies into immutable Sprint scope without creating another approval questionnaire.
import { readArchitectureDecisions, decisionError } from "./architecture-owner-decisions.js";

// Captures choices only from the exact authenticated parent artifact, never from Sprint Leader output.
export function sprintArchitectureDecisions(parent) {
  if (!parent) return null;
  const record = readArchitectureDecisions(parent.markdown);
  if (!record) return null;
  if (record.source_path !== parent.source_path || record.source_sha256 !== parent.source_sha256 || parent.status !== "approved" || parent.decision?.decision !== "approved" || parent.decision.sha256 !== parent.sha256) throw decisionError("ARCHITECTURE_DECISIONS_INVALID", "Sprint policies require the exact approved Architecture source.");
  return { ...record, parent_plan_id: parent.plan_id, parent_revision: parent.revision, parent_sha256: parent.sha256, approval_decision_id: parent.decision.decision_id, approver_id: parent.decision.approver_id };
}

// Refuses new policy questionnaires or deferred owner prerequisites instead of silently waiving them.
export function assertNoSprintPolicyRequests(content, { enforce = false } = {}) {
  if (!content.architecture_decisions && !enforce) return;
  if ((content.decision_requests ?? []).length || (content.ticket_specs ?? []).some((ticket) => (ticket.verification_plan ?? []).some((step) => step.kind === "human"))) throw decisionError("ARCHITECTURE_REPLAN_REQUIRED", "Owner decisions belong in the Architecture plan. SL must consume them, not create new approval requests; unresolved authority needs Architecture replanning.");
}
