// Reconsiders legacy false admission waits from fresh Node evidence without replaying Coder or clearing real denials.
import { createBlockerVerificationResume } from "./blocker-verification-resume.js";
import { createBlockerFailureClassification, requiresBlockerAdmission } from "./blocker-failure-classification.js";
import { createBlockerSourceResume } from "./blocker-source-resume.js";

// Returns ordinary verification refresh plus a source-bound recovery for obsolete missing-denial errors.
export function createBlockerReconciliationRefresh({ inspect, clock = Date.now, projectLogger = () => {}, readFailureEvidence, sprintRegistry, ticketStatusStore }) {
  const refreshVerification = createBlockerVerificationResume({ inspect, clock, projectLogger });
  const refreshSource = createBlockerSourceResume({ inspect, clock, projectLogger, sprintRegistry, ticketStatusStore });
  const classify = createBlockerFailureClassification({ readFailureEvidence });
  return async (job) => {
    if (await refreshVerification(job)) return true;
    if (await refreshSource(job)) return true;
    if (job.outcome_reason !== "EXECUTION_ADMISSION_EVIDENCE_REQUIRED" || job.execution_admission) return false;
    const authority = await inspect(job);
    if (!authority) return false;
    const classification = await classify(job, authority.workspace);
    const progress = { ...job.ticket_progress, failure_classification: classification };
    if (classification?.category !== "technical_failure" || requiresBlockerAdmission({ ...job, ticket_progress: progress })) return false;
    job.history.push({ stage: "sprint_leader", event: "admission_misclassification_corrected", completed_at: clock(),
      original_reason: job.outcome_reason, previous_stage: job.stage, previous_resolution: job.resolution ?? null,
      previous_feedback: job.validation_feedback ?? [], classification });
    job.ticket_progress = progress;
    delete job.validation_feedback;
    delete job.resolution;
    // The recovery loop assigns SL and retains the original execution/failure/checkpoint before invoking any agent.
    projectLogger({ event_name: "supervisor.blocker_admission_corrected", level: "info", status: "pending", task_id: job.request.task_id,
      message: "Node corrected a legacy admission wait from original technical receipts; SL will reassess the retained checkpoint. No tool permission or approval was granted.",
      payload: { job_id: job.id, classification } });
    return true;
  };
}
