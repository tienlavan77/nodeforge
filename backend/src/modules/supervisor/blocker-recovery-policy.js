// Resolves deploy-time blocker investigation budgets so legitimately slow SL/Architecture SDK runs are not cut short.
// Each execution persists its own immutable policy snapshot; production overrides the conservative library defaults.

const MAX_CALLS = ["sprint_leader", "architecture_manager"].length; // One budgeted call per authority stage.
const DEFAULT_CALL_STAGE_BUDGET = 2; // Allow one Node-validated correction re-try per stage.
const DEFAULT_MAX_RESUMES = 2;
// A gateway-backed SL/Architecture investigation can legitimately run for tens of minutes. Keep the ledger window
// aligned with the SDK gateway ceiling so the per-stage abort (deadline-driven, see blocker-recovery-agent.js) is the
// authoritative backstop rather than an artificially short budget that fabricates provider-unknown reconciliations.
const DEFAULT_DEADLINE_MS = 3_600_000;

// Reads bounded limits from the environment, validating against the same finite range enforced by createBlockerRecovery.
export function blockerRecoveryPolicy(environment = process.env) {
  const maxCalls = Number(environment.NODEFORGE_BLOCKER_MAX_CALLS ?? MAX_CALLS * DEFAULT_CALL_STAGE_BUDGET);
  const maxResumes = Number(environment.NODEFORGE_BLOCKER_MAX_RESUMES ?? DEFAULT_MAX_RESUMES);
  const deadlineMs = Number(environment.NODEFORGE_BLOCKER_DEADLINE_MS ?? DEFAULT_DEADLINE_MS);
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 8
    || !Number.isSafeInteger(maxResumes) || maxResumes < 1 || maxResumes > 2
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 3_600_000) throw new Error("Invalid bounded blocker recovery configuration.");
  return { maxCalls, maxResumes, deadlineMs };
}
