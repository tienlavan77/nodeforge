// Releases abandoned file ownership after an authenticated ticket cancellation while preserving source and audit history.
import { releaseInactiveTicketClaims } from "./ticket-inactive-claims.js";

// Applies an existing owner cancellation only when no provider or incomplete write still owns the cancelled work.
export function createCancelledTicketClaimReconciliation({ projectId, fileService, isExecutionActive, projectLogger = () => {} }) {
  if (!projectId || typeof isExecutionActive !== "function") throw new Error("Cancelled claim reconciliation requires project identity and execution fencing.");
  return reconcile;

  // Removes cancelled-ticket claims through the existing locked journal without changing source, commits or review findings.
  async function reconcile(record) {
    if (record?.disposition !== "cancelled") return null;
    if (record.project_id !== projectId || !/^[A-Za-z0-9._:-]+$/.test(record.task_id ?? "")
      || !["human", "sprint-leader"].includes(record.actor_role) || !record.actor_id
      || !Array.isArray(record.evidence_refs) || !record.evidence_refs.length
      || record.evidence_refs.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error("Cancelled claim cleanup requires an authenticated, evidence-bearing owner decision.");
    const result = await releaseInactiveTicketClaims({ projectId, taskId: record.task_id, fileService, isExecutionActive, close: true, projectLogger });
    if (result.status !== "released") return result;
    projectLogger({ event_name: "ticket.cancelled_claims_reconciled", level: "info", status: "success", task_id: record.task_id,
      source: "ticket-cancelled-claims", message: "Existing owner cancellation released inactive ticket claims; source and journal were preserved.",
      payload: { actor_id: record.actor_id, decided_at: record.decided_at, path_count: result.paths.length } });
    return result;
  }
}
