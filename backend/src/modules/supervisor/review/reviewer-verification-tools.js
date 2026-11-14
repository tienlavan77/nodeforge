/**
 * Business purpose: provides bounded Reviewer-only verification helpers without
 * inflating the main Forge tool assembly module beyond the repository size limit.
 * Technical description: exports the diff and fail-closed check tool factories.
 */
import { createCommittedReviewSource } from "./reviewer-committed-source.js";

/**
 * Business purpose: exposes the verified patch for one ticket file to Reviewer.
 * Technical description: resolves the pinned base and review commits and bounds
 * the returned patch while attaching artifact provenance.
 */
export function createReviewDiffTool({ projectRoot, ticketEvidence, job, toolError, maxResultBytes }) {
  return { execute: async (input = {}) => {
    if (!input || typeof input !== "object" || typeof input.path !== "string" || !input.path.trim()) throw toolError("REVIEW_TOOL_INPUT", "review_diff requires a file path.");
    const base = input.base === "previous_review" && job?.payload?.previous_review_commit ? job.payload.previous_review_commit : ticketEvidence.context.base_sha;
    const commit = ticketEvidence.context.review_commit_sha;
    const patch = await createCommittedReviewSource({ projectRoot, commit, baseCommit: base, ticketEvidence }).diffPatchFrom(base, { paths: [input.path] });
    return { path: input.path, base_commit: base, commit_sha: commit, patch: patch.slice(0, maxResultBytes - 1024), review_evidence: { artifact_id: ticketEvidence.artifact.artifact_id, commit_sha: commit, manifest_sha: ticketEvidence.context.manifest_sha } };
  } };
}

/**
 * Business purpose: prevents Reviewer from treating an ungoverned local command
 * as a verified project check.
 * Technical description: returns the stable fail-closed diagnostic tool contract.
 */
export function createRunReviewCheckTool({ toolError }) {
  return { execute: async () => { throw toolError("REVIEW_CHECK_ISOLATION_UNSUPPORTED", "Reviewer checks are unavailable until subprocess isolation and recorded source, dependency and toolchain provenance are enforced. Do not substitute native shell or live dependencies."); } };
}
