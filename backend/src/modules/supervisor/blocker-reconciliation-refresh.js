// Reconsiders legacy false admission waits from fresh Node evidence without replaying Coder or clearing real denials.
import { createBlockerVerificationDelivery } from "./blocker-verification-delivery.js";
import { createBlockerContractRefresh } from "./blocker-contract-delegation.js";
import { createBlockerPromptRefresh } from "./blocker-prompt-context.js";
import { assignAuthorityConsultation } from "./blocker-authority-consultation.js";
import { createBlockerVerificationResume } from "./blocker-verification-resume.js";
import { createBlockerFailureClassification, requiresBlockerAdmission } from "./blocker-failure-classification.js";
import { createBlockerSourceResume } from "./blocker-source-resume.js";
import { inspectReviewResponseReadiness } from "./review-response-readiness.js";
import { createBlockerAdmissionRefresh } from "./blocker-admission-refresh.js";

// Returns ordinary verification refresh plus a source-bound recovery for obsolete missing-denial errors.
export function createBlockerReconciliationRefresh({ inspect, fileService, clock = Date.now, projectLogger = () => {}, readFailureEvidence, sprintRegistry, ticketStatusStore }) {
  const refreshContract = createBlockerContractRefresh({ inspect, fileService, clock, projectLogger });
  const refreshAdmission = createBlockerAdmissionRefresh({ inspect, clock, projectLogger, readFailureEvidence });
  const refreshPrompt = createBlockerPromptRefresh({ inspect, clock, projectLogger });
  const refreshDelivery = createBlockerVerificationDelivery({ inspect, clock, projectLogger });
  const refreshVerification = createBlockerVerificationResume({ inspect, clock, projectLogger });
  const refreshSource = createBlockerSourceResume({ inspect, clock, projectLogger, sprintRegistry, ticketStatusStore });
  const classify = createBlockerFailureClassification({ readFailureEvidence });
  return async (job) => {
    if (await refreshAdmission(job)) return true;
    if (await refreshPrompt(job)) return true;
    if (await refreshContract(job)) return true;
    if (await refreshVerification(job)) return true;
    if (await refreshDelivery(job)) return true;
    if (await refreshSource(job)) return true;
    if (job.reason_code === "ACCESS_REQUIRED" && job.ticket_progress?.failure_classification) {
      const authority = await inspect(job);
      const classification = authority ? await classify(job, authority.workspace) : null;
      const progress = { ...job.ticket_progress, failure_classification: classification };
      if (classification?.category === "technical_failure" && !requiresBlockerAdmission({ ...job, ticket_progress: progress })
        && JSON.stringify(classification) !== JSON.stringify(job.ticket_progress.failure_classification)) {
        job.history.push({ stage: "sprint_leader", event: "technical_failure_classification_refreshed", completed_at: clock(),
          previous_resolution: job.resolution ?? null, previous_feedback: job.validation_feedback ?? [] });
        job.ticket_progress = progress;
        delete job.validation_feedback; delete job.resolution;
        projectLogger({ event_name: "supervisor.blocker_classification_refreshed", level: "info", status: "pending", task_id: job.request.task_id,
          message: "Original technical receipts now clear the obsolete access classification; SL will reassess the retained checkpoint.", payload: { job_id: job.id, classification } });
        return true;
      }
    }
    if (job.outcome_reason === "technical_reconciliation_waiting_for_evidence") {
      const authority = await inspect(job);
      if (authority && assignAuthorityConsultation(job, job.resolution, clock())) {
        projectLogger({ event_name: "supervisor.blocker_authority_consultation", level: "info", status: "pending", task_id: job.request.task_id,
          message: "Unreviewed contract/denial question assigned to Architecture; its answer returns to Sprint Leader. The denied operation remains blocked.", payload: { job_id: job.id } });
        return true;
      }
      const delivery = authority ? await inspectReviewResponseReadiness(authority.workspace, job.request?.task_id) : null;
      if (delivery?.status === "available" && JSON.stringify(delivery) !== JSON.stringify(job.ticket_progress?.review_response_delivery ?? null)) {
        job.history.push({ stage: "sprint_leader", event: "review_response_delivery_available", completed_at: clock(), previous_resolution: job.resolution ?? null });
        job.ticket_progress = { ...job.ticket_progress, review_response_delivery: delivery };
        delete job.validation_feedback; delete job.resolution;
        projectLogger({ event_name: "supervisor.blocker_review_response_ready", level: "info", status: "pending", task_id: job.request.task_id,
          message: "Verified finding-response delivery is available; SL will resume Coder without changing its completed report.", payload: { job_id: job.id, artifact_id: delivery.artifact_id } });
        return true;
      }
      const retained = await authority?.workspace.inspectFindingReviewSource?.();
      if (retained?.status === "available_for_unchanged_response"
        && JSON.stringify(retained) !== JSON.stringify(job.ticket_progress?.retained_review_source ?? null)) {
        job.history.push({ stage: "sprint_leader", event: "review_source_evidence_available", completed_at: clock(),
          previous_resolution: job.resolution ?? null, retained_review_source: retained });
        job.ticket_progress = { ...job.ticket_progress, retained_review_source: retained };
        delete job.validation_feedback;
        delete job.resolution;
        projectLogger({ event_name: "supervisor.blocker_review_evidence_ready", level: "info", status: "pending", task_id: job.request.task_id,
          message: "Retained verified review source is available; SL will resume evidence-only recovery without duplicate edits or commits.",
          payload: { job_id: job.id, artifact_id: retained.artifact_id, commit_sha: retained.commit_sha } });
        return true;
      }
    }
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
