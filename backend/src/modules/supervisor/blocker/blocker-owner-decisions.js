// Preserves Node-recorded owner blocker choices across subsequent SL/Architecture jobs without granting contract authority.

// Collects decision receipts from the current ticket's durable checkpoint and status, excluding untrusted failure prose.
export function blockerOwnerDecisions(checkpoint, current) {
  const decisions = new Map();
  for (const decision of [...(checkpoint?.blocker_owner_decisions ?? []), checkpoint?.blocker_recovery?.owner_decision, current?.details?.owner_decision]) {
    if (!decision || typeof decision.decision_id !== "string" || !decision.decision_id.startsWith("BLOCKER-DECISION-") || typeof decision.option_id !== "string" || !decision.option_id.trim()) continue;
    if (!decisions.has(decision.decision_id)) decisions.set(decision.decision_id, structuredClone(decision));
  }
  return [...decisions.values()];
}
