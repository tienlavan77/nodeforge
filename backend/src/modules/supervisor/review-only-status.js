// Prepares canonical ticket status so independent Reviewer outcomes reach the Sprint DAG.
import { ConfigurationError } from "../../shared/errors.js";

// Moves a reviewed ticket into reviewing before the terminal bridge handles its verdict.
export function ensureReviewStatusReady(ticketStatusStore, taskId) {
  if (!ticketStatusStore) return;
  let status = ticketStatusStore.get(taskId)?.status;
  if (!status) { ticketStatusStore.create(taskId); status = "pending"; }
  if (["failed", "needs_human_review"].includes(status)) { ticketStatusStore.retry(taskId, { reason: "review_only_retry" }); status = "pending"; }
  if (status === "blocked") { ticketStatusStore.updateStatus(taskId, "pending", { reason: "review_only" }); status = "pending"; }
  if (status === "pending") { ticketStatusStore.updateStatus(taskId, "running", { reason: "review_only" }); status = "running"; }
  if (status === "running") ticketStatusStore.updateStatus(taskId, "reviewing", { reason: "review_only" });
  else if (!["reviewing", "done"].includes(status)) throw Object.assign(new ConfigurationError(`Ticket cannot enter review from ${status}.`), { code: "REVIEW_STATUS_INVALID" });
}
