// Wires automatic review into production without changing direct-code or manual review-only execution.
import { createCompletedReviewResume } from "./completed-review-resume.js";
import { createAutomaticTicketReview } from "./automatic-ticket-review.js";
import { createAutomaticReviewWorkerResolver } from "./automatic-review-source.js";

// Enables revision-bound automatic review only when ticket workspaces provide immutable verification evidence.
export function createProductionAutomaticReview(options) {
  if (!options.resolveTicketWorkspace) return null;
  const bound = { ...options, resolveWorker: createAutomaticReviewWorkerResolver(options) };
  return Object.freeze({ ...createAutomaticTicketReview(bound), resumeCompleted: createCompletedReviewResume(bound) });
}
