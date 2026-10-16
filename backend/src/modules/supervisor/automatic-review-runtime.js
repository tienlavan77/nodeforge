// Wires automatic review into production without changing direct-code or manual review-only execution.
import { createAutomaticTicketReview } from "./automatic-ticket-review.js";
import { createAutomaticReviewWorkerResolver } from "./automatic-review-source.js";

// Enables revision-bound automatic review only when ticket workspaces provide immutable verification evidence.
export function createProductionAutomaticReview(options) {
  if (!options.resolveTicketWorkspace) return null;
  return createAutomaticTicketReview({ ...options, resolveWorker: createAutomaticReviewWorkerResolver(options) });
}
