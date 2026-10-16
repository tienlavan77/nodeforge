// Routes Coder failures without confusing infrastructure recovery with repair or human authority.
const TRANSIENT = new Set(["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "SERVICE_UNAVAILABLE"]);

// Requires explicit terminal invocation evidence rather than guessing retry safety from SDK prose.
export function classifyCoderFailure(error = {}) {
  if (!error || typeof error !== "object") return "terminal";
  const code = typeof error.code === "string" ? error.code : "UNKNOWN_FAILURE";
  if (["PROVIDER_UNKNOWN", "TICKET_EXECUTION_RECONCILIATION_REQUIRED", "REVIEW_PROVIDER_OUTCOME_UNKNOWN"].includes(code)
    || error.provider_outcome === "unknown" || error.provider_outcome === "active" || error.reconciliation_error) return "reconcile";
  if (code === "CODER_BLOCKED" || code === "COMMIT_APPROVAL_REJECTED" || code.startsWith("HUMAN_REVIEW_")) return "authority";
  if (code === "REVIEW_VERDICT_INVALID") return "reviewer";
  if (["VERIFY_COMMAND_FAILED", "CODER_EVIDENCE_PENDING", "CODER_COMPLETION_REQUIRED"].includes(code)) return "repair";
  const cause = error.cause?.code ?? code;
  const sdkFailure = TRANSIENT.has(code) || ["CONFIGURATION_ERROR", "AGENT_PROCESS_EXITED", "AGENT_REQUEST_FAILED"].includes(code);
  return sdkFailure && TRANSIENT.has(cause) && error.provider_outcome === "failed" && error.retry_safe === true ? "transient" : "terminal";
}
