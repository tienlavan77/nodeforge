// Persists a Coder's response to Reviewer findings without granting approval authority.
import { ConfigurationError } from "../shared/errors.js";
import { createRequire } from "node:module";
import { assertReviewVerificationRequests, reviewVerificationRequestSchema } from "../modules/supervisor/review-verification-contract.js";

const require = createRequire(import.meta.url);
export const respondToReviewInputSchema = structuredClone(require("../../../schemas/agent/tools/respond-to-review.schema.json"));
respondToReviewInputSchema.properties.responses.items.properties.verification_requests.items = reviewVerificationRequestSchema;

// Creates the governed petition tool for an open ticket review.
export function createRespondToReviewTool({ reviewFindings, verificationService } = {}) {
  if (!reviewFindings?.recordResponse || !verificationService?.assertPassedArtifact) throw new ConfigurationError("Review response requires findings and verification services.");
  return Object.freeze({ name: "respond_to_review", async execute(input = {}, context = {}) {
    const artifact = await verificationService.assertPassedArtifact();
    if (input.review_commit_sha !== artifact.commit_sha || input.artifact_id !== artifact.artifact_id || input.source_revision !== artifact.source_revision) {
      const error = new ConfigurationError("Review response identity differs from the passed ticket artifact.");
      error.code = "REVIEW_RESPONSE_STALE";
      throw error;
    }
    const history = await reviewFindings.load();
    for (const response of input.responses ?? []) if (response.verification_requests !== undefined) {
      assertReviewVerificationRequests(response.verification_requests, { artifact, findingIds: [response.finding_id] });
      if (response.verification_requests.some((request) => !request.finding_ids.includes(response.finding_id))) throw Object.assign(new ConfigurationError("Verification requests must name the response finding."), { code: "REVIEW_RESPONSE_INVALID" });
    }
    if (!(history.coder_reports ?? []).some((entry) => entry.artifact_id === artifact.artifact_id && entry.review_commit_sha === artifact.commit_sha)) {
      const error = new ConfigurationError("Complete the saved Coder report for this artifact with report_done before responding to Reviewer findings.");
      error.code = "CODER_EXPLANATION_MISSING";
      throw error;
    }
    const response = await reviewFindings.recordResponse({ responses: input.responses, artifact, actor: context.agent_identity?.agent_id, idempotencyKey: input.idempotency_key });
    return { response_id: response.idempotency_key, status: "submitted_for_review", artifact_id: artifact.artifact_id };
  } });
}
