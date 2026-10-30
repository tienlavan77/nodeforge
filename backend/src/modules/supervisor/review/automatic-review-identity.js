// Binds automatic ticket review to the verified revision, approved contract, and effective review policy.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../../shared/errors.js";

// Hashes structured review evidence independently of object property insertion order.
export function reviewDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalReviewValue(value))).digest("hex")}`;
}

// Sorts nested contract objects while preserving the semantic order of arrays.
function canonicalReviewValue(value) {
  if (Array.isArray(value)) return value.map(canonicalReviewValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonicalReviewValue(value[key])]));
  return value;
}

// Captures the review gate while allowing finding-driven repairs without a revision cap.
export function automaticReviewPolicy(ticket, { blocking = false } = {}) {
  const policy = ticket?.execution_policy ?? {};
  const gate = blocking ? "on" : policy.review_gate ?? "on";
  if (!["off", "on"].includes(gate)) throw Object.assign(new ConfigurationError("Automatic review policy is invalid."), { code: "REVIEW_POLICY_INVALID" });
  return { gate, max_operational_attempts: 3 };
}

// Rejects incomplete artifacts and keys each logical review by all source and contract evidence.
export function automaticReviewIdentity({ request, artifact, context, policy, rules, exchange }) {
  const identity = { task_id: request.task_id, source_revision: artifact.source_revision, review_commit_sha: artifact.commit_sha,
    artifact_id: artifact.artifact_id, base_sha: artifact.base_sha, manifest_sha: artifact.manifest_sha,
    review_policy_sha: reviewDigest({ policy, rules }), contract_sha: reviewDigest(request.ticket), file_checksums_sha: reviewDigest(artifact.file_checksums),
    coder_exchange_sha: reviewDigest({ coder_reports: (exchange?.coder_reports ?? []).filter((entry) => entry.artifact_id === artifact.artifact_id), coder_responses: exchange?.coder_responses ?? [] }) };
  if (Object.values(identity).some((value) => value === undefined || value === null || value === "") || !artifact.file_checksums || artifact.status !== "passed"
    || context.source_revision !== artifact.source_revision || context.review_commit_sha !== artifact.commit_sha || context.manifest_sha !== artifact.manifest_sha || context.base_sha !== artifact.base_sha || context.verification_artifact_id !== artifact.artifact_id) {
    throw Object.assign(new ConfigurationError("Automatic review requires the exact passed ticket artifact."), { code: "REVIEW_EVIDENCE_MISMATCH" });
  }
  return { identity, job_key: reviewDigest(identity) };
}

// Prevents a deferred review or completion event from being applied to a different ticket revision after recovery.
export function matchesAutomaticReviewContext(context, job) {
  const identity = job.decision_identity;
  return context?.source_revision === identity.source_revision && context.review_commit_sha === identity.review_commit_sha && context.verification_artifact_id === identity.artifact_id
    && context.base_sha === identity.base_sha && context.manifest_sha === identity.manifest_sha;
}

// Restores the Node-owned repair cycle after operational/blocker resume without changing its review policy.
export function bindAutomaticReviewCycle(request, context) {
  const cycle = context?.review_repair_cycle_id;
  if (!cycle) return request;
  if (request.payload?.review_cycle_id && request.payload.review_cycle_id !== cycle) throw Object.assign(new ConfigurationError("Review repair cycle differs from the retained execution context."), { code: "REVIEW_POLICY_CONFLICT" });
  return { ...request, payload: { ...request.payload, review_cycle_id: cycle } };
}
