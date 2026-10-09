// Binds Ticket execution evidence to its immutable Project/Sprint plan instead of reusing status by ID alone.
const PLAN_FIELDS = ["project_id", "sprint_id", "plan_id", "plan_revision", "plan_path", "plan_sha256"];

// Requires a complete immutable scheduling basis before associating durable Ticket execution evidence.
export function validExecutionBasis(basis) {
  return Boolean(basis && PLAN_FIELDS.every((field) => basis[field] !== undefined && basis[field] !== null) && Number.isSafeInteger(basis.version) && basis.version >= 0 && Number.isSafeInteger(basis.plan_revision) && basis.plan_revision > 0 && /^[a-f0-9]{64}$/.test(basis.plan_sha256));
}

// Allows completion reuse only for the exact immutable plan; scheduling status writes do not change plan identity.
export function sameExecutionPlan(left, right) {
  return validExecutionBasis(left) && validExecutionBasis(right) && PLAN_FIELDS.every((field) => left[field] === right[field]);
}

// Fences events and failure callbacks to the exact persisted execution ID and observed scheduling version.
export function matchesTicketExecution(current, executionId, basis) {
  return Boolean(typeof executionId === "string" && executionId && current?.project_id === basis?.project_id && current.details?.execution_id === executionId && sameExecutionPlan(current.details?.execution_basis, basis) && current.details.execution_basis.version === basis.version);
}

// Preserves execution identity when an existing lifecycle writer supplies only phase-specific details.
export function retainedExecutionDetails(details) {
  return details?.execution_id ? { execution_id: details.execution_id, execution_basis: details.execution_basis } : {};
}
