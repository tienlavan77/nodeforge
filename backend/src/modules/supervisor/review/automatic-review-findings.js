// Persists independent review findings for both blocking and post-completion review before publishing the verdict.
import { automaticReviewIdentity, matchesAutomaticReviewContext } from "./automatic-review-identity.js";

// Binds durable findings to the selected artifact without reopening terminal tickets or granting execution authority.
export async function recordAutomaticReviewFindings({ job, workspace, payload }) {
  const context = await workspace.executionContexts.load(job.task_id);
  let artifact;
  if (job.review_policy.gate === "on") {
    artifact = await workspace.testService.assertPassedArtifact();
    const next = automaticReviewIdentity({ request: job.source_request, artifact, context, policy: job.review_policy, rules: job.review_rules, exchange: await workspace.reviewFindings.load() });
    if (next.job_key !== job.job_key) throw failure("Source changed while Reviewer was deciding.");
  } else {
    if (context?.state !== "terminal" || !matchesAutomaticReviewContext(context, job)) throw failure("Completed source changed while Reviewer was deciding.");
    artifact = job.payload.verification;
  }
  await workspace.reviewFindings.recordReview({ ...payload, artifactId: artifact.artifact_id, commitSha: artifact.commit_sha,
    reviewerId: payload.reviewer_id, sourceRevision: artifact.source_revision });
  if (payload.verdict === "approved") await workspace.reviewFindings.assertResolved();
}

// Rejects stale review evidence rather than associating findings with a different ticket revision.
function failure(message) { return Object.assign(new Error(message), { code: "REVIEW_EVIDENCE_MISMATCH" }); }
