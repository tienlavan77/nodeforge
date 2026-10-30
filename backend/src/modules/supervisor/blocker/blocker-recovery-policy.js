// Resolves deploy-time blocker deadlines without limiting investigation calls or Coder resume counts.
// Each execution persists its own immutable policy snapshot; production overrides the conservative library defaults.

// A gateway-backed SL/Architecture investigation can legitimately run for tens of minutes. Keep the ledger window
// aligned with the SDK gateway ceiling so the per-stage abort (deadline-driven, see blocker-recovery-agent.js) is the
// authoritative backstop rather than an artificially short budget that fabricates provider-unknown reconciliations.
const DEFAULT_DEADLINE_MS = 3_600_000;

// Reads bounded limits from the environment, validating against the same finite range enforced by createBlockerRecovery.
export function blockerRecoveryPolicy(environment = process.env) {
  const deadlineMs = Number(environment.NODEFORGE_BLOCKER_DEADLINE_MS ?? DEFAULT_DEADLINE_MS);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 3_600_000) throw new Error("Invalid bounded blocker recovery configuration.");
  return { deadlineMs };
}
