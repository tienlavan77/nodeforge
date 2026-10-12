// Rejects misplaced owner checkpoints and identity changes so recovery cannot cross role or conversation boundaries.
import { ConfigurationError } from "../shared/errors.js";

const IDENTITY_FIELDS = ["conversation_id", "execution_id", "role", "lineage_id", "attempt_number", "resume_of"];

// Blocks recovery of corrupt or cross-role records without rewriting or deleting their audit evidence.
export function assertOwnerExecutionRecord(record, { role, conversationId, executionId }) {
  if (record?.role === role && record.conversation_id === conversationId && (executionId === undefined || record.execution_id === executionId)) return;
  console.error("Owner execution checkpoint identity mismatch; manual review required.", { expected_role: role, record_role: record?.role ?? null });
  throw Object.assign(new ConfigurationError("Owner execution checkpoint requires manual identity reconciliation."), { code: "EXECUTION_RECONCILIATION_REQUIRED", statusCode: 404, recovery_status: "manual_required" });
}

// Prevents any transition from overwriting the original role, lineage, or attempt identity.
export function assertOwnerExecutionIdentity(current, next) {
  if (current && IDENTITY_FIELDS.some((field) => next[field] !== current[field])) {
    throw Object.assign(new ConfigurationError("Owner execution checkpoint identity is immutable."), { code: "EXECUTION_IDENTITY_IMMUTABLE", statusCode: 409 });
  }
}
