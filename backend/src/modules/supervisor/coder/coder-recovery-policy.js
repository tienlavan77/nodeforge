// Defines bounded operational recovery and preserves existing SL and owner decision boundaries.

// Resolves deploy-time retry limits; each execution persists its own immutable policy snapshot.
export function coderRecoveryPolicy(environment = process.env) {
  if (environment.NODEFORGE_CODER_RETRY_ENABLED !== undefined && !["true", "false"].includes(environment.NODEFORGE_CODER_RETRY_ENABLED)) throw new Error("NODEFORGE_CODER_RETRY_ENABLED must be true or false.");
  if (environment.NODEFORGE_CODER_RETRY_ENABLED === "false") return null;
  const maxRetries = Number(environment.NODEFORGE_CODER_MAX_RETRIES ?? 2);
  const deadlineMs = Number(environment.NODEFORGE_CODER_RETRY_DEADLINE_MS ?? 600_000);
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 1 || maxRetries > 10
    || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 30_000 || deadlineMs > 86_400_000) throw new Error("Invalid bounded Coder retry configuration.");
  return { policy_id: "coder-operational-v1", max_retries: maxRetries, deadline_ms: deadlineMs };
}

// Assigns triage responsibility without authorizing SL to alter scope, security, contracts, or findings.
export function coderFailureTriage(error) {
  const reason = error.details?.blocker?.reason_code ?? error.code;
  const consultation = error.details?.consultation ?? error.details?.blocker?.consultation;
  return { reason_code: reason, triage_role: "sprint-leader", decision_role: "existing_authority",
    allowed_actions: ["inspect_evidence", "clarify_approved_criteria", "propose_follow_up", "escalate"],
    authority_basis: "existing_authority_no_delegation_expansion", evidence_refs: error.details?.evidence ?? [],
    ...(consultation ? { consultation } : error.details?.blocker?.owner_action ? { consultation: {
      question: error.details.summary || error.message || reason, decision_needed: error.details.blocker.owner_action,
      known_decision_refs: [], impact: error.details.summary || error.message || reason } } : {}) };
}
