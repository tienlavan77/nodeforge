// Restores legacy review findings from a completed, source-bound Reviewer checkpoint before Coder repair.
import { matchesAutomaticReviewContext } from "./automatic-review-identity.js";

// Reconciles missing durable findings without replaying Reviewer or reopening independently closed findings.
export async function restoreCompletedReviewFindings({ job, prior, workspace, projectLogger = () => {} }) {
  const artifact = job.payload.verification;
  const context = await workspace.executionContexts.load(job.task_id);
  if (prior?.status !== "completed" || prior.verdict !== "request_changes" || prior.task_id !== job.task_id
    || prior.commit !== artifact.commit_sha || prior.verification?.artifact_id !== artifact.artifact_id
    || prior.verification?.commit_sha !== artifact.commit_sha || prior.verification?.manifest_sha !== artifact.manifest_sha
    || prior.verification?.source_revision !== artifact.source_revision
    || prior.source_revision !== undefined && prior.source_revision !== artifact.source_revision
    || !matchesAutomaticReviewContext(context, job)) throw failure("REVIEW_REPAIR_SOURCE_CONFLICT", "Retained Reviewer findings do not match the selected ticket revision.");
  const record = await workspace.reviewFindings.load();
  const missing = (prior.findings ?? []).filter((finding) => !record.findings.some((entry) =>
    entry.message === (typeof finding === "string" ? finding : finding.failure)?.trim()
    && entry.review_commit_sha === artifact.commit_sha && entry.artifact_id === artifact.artifact_id));
  if (!missing.length) return workspace.reviewFindings.unresolved();
  if (!prior.request_id || !prior.reviewer_id || prior.reviewer_id === job.agent_id) throw failure("REVIEW_REPAIR_SOURCE_CONFLICT", "Finding recovery requires the original independent Reviewer identity and request.");
  await workspace.reviewFindings.recordReview({ verdict: "request_changes", findings: missing, adjudications: prior.adjudications ?? [],
    artifactId: artifact.artifact_id, commitSha: artifact.commit_sha, reviewerId: prior.reviewer_id, sourceRevision: artifact.source_revision });
  projectLogger({ event_name: "review.findings_recovered", level: "info", status: "success", message: "Persisted Reviewer findings recovered from the completed checkpoint.",
    task_id: job.task_id, source: "completed-review-findings", payload: { findings_count: missing.length, request_id: prior.request_id, artifact_id: artifact.artifact_id, commit_sha: artifact.commit_sha } });
  return workspace.reviewFindings.unresolved();
}

// Keeps conflicting review history out of the Coder repair pipeline.
function failure(code, message) { return Object.assign(new Error(message), { code, statusCode: 409 }); }
