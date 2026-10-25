/** Resolves independent blocker evidence through existing immutable Git and
 * verification-environment services. A failed historical artifact is diagnostic
 * evidence, never a replacement for the current ticket's verification result. */
import { createFileService } from "../../infrastructure/filesystem/file-service.js";
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { createCommittedReviewSource } from "./reviewer-committed-source.js";
import { createVerificationReviewSource } from "./ticket-verification-review-source.js";
import { BLOCKER_RECEIPT_MAX_BYTES } from "./blocker-evidence-limits.js";
import { blockerValidationError } from "./blocker-validation.js";
import { validateReviewerEvidenceResult } from "./blocker-reviewer-evidence.js";
import { createBlockerEvidenceFiles } from "./blocker-evidence-files.js";

/** Accepts only an already inventoried receipt belonging to this ticket/project
 * and the requested commit, checking its original checksum before any dispatch. */
export async function readReviewerEvidenceArtifact({ job, projectRoot, subject }) {
  const path = `${statePath()}/ticket-verification/${job.request.task_id}/artifacts/${subject.artifact_id}.json`;
  const receipt = job.ticket_progress?.verification?.receipt_index?.find((entry) => entry.type === "artifacts" && entry.evidence_ref === path);
  if (!receipt?.receipt_sha256 || receipt.commit_sha !== subject.commit_sha)
    throw blockerValidationError("/reconciliation/waiting_for/subject", "reviewer_subject_unknown", "Choose an issued artifact and its exact retained commit from verification.receipt_index.");
  const fileService = createFileService({ projectRoot, role: "system_engineer" });
  const file = await fileService.readForIndex({ path, maxBytes: BLOCKER_RECEIPT_MAX_BYTES });
  const artifact = JSON.parse(file.content);
  if (file.sha256 !== receipt.receipt_sha256 || artifact.task_id !== job.request.task_id || artifact.project_id !== job.request.project_id
    || artifact.artifact_id !== subject.artifact_id || artifact.commit_sha !== subject.commit_sha)
    throw blockerValidationError("/reconciliation/waiting_for/subject", "reviewer_subject_stale", "The artifact changed or belongs to another commit/ticket/project. Refresh the evidence inventory.");
  return artifact;
}

/** Reuses snapshot and environment readers for every source search and window;
 * unrelated working-tree changes cannot contaminate the independent report. */
export async function createBlockerReviewerSource({ job, projectRoot }) {
  const subject = job.reviewer_evidence.request.subject;
  const artifact = await readReviewerEvidenceArtifact({ job, projectRoot, subject });
  const committed = createCommittedReviewSource({ projectRoot, commit: subject.commit_sha, baseCommit: artifact.base_sha });
  const source = createVerificationReviewSource({ projectRoot, source: committed, getArtifact: async () => artifact,
    getTicketPaths: async () => artifact.changed_paths ?? [] });
  return { source, artifact };
}

/** Verifies source citations against the exact reviewed snapshot before AM
 * receives the report. Current workspace bytes never certify historical facts. */
export async function validateBlockerReviewerEvidence(value, job, projectRoot) {
  validateReviewerEvidenceResult(value, job);
  const { source } = await createBlockerReviewerSource({ job, projectRoot });
  const { files } = createBlockerEvidenceFiles({ files: source, projectRoot, profile: { role: "reviewer" }, taskId: job.request.task_id, job });
  for (const [index, ref] of (value.evidence ?? []).entries()) {
    if (!ref.sha256) continue;
    if (typeof ref.path !== "string" || !ref.path.trim())
      throw blockerValidationError(`/evidence/${index}/path`, "reviewer_evidence_invalid", "Cite the inspected source or issued receipt path.");
    // Citation coordinates locate the observation inside a source file; they
    // must not become part of the immutable snapshot's filesystem lookup key.
    const path = ref.path.replace(/:\d+(?::\d+)?$/, "");
    let file;
    try { file = await files.readForIndex({ path }); }
    catch (error) {
      if (!["ENOENT", "FILE_NOT_FOUND"].includes(error.code)) throw error;
      throw blockerValidationError(`/evidence/${index}/path`, "reviewer_evidence_missing", `Citation ${ref.path} is absent from the assigned source or recorded environment: ${error.message} Return inspected references and identify missing evidence; do not substitute mutable workspace files.`);
    }
    if (file.sha256.replace(/^sha256:/, "") !== ref.sha256.replace(/^sha256:/, ""))
      throw blockerValidationError(`/evidence/${index}/sha256`, "reviewer_evidence_mismatch", "Cite the exact source or issued receipt checksum, not mutable workspace evidence.");
  }
  if (value.review_evidence.outcome === "completed" && !(value.evidence ?? []).some((ref) => ref.sha256))
    throw blockerValidationError("/evidence", "reviewer_evidence_required", "A completed independent report needs at least one checksummed inspected source or receipt.");
  return value;
}

/** Rechecks a completed, retained Reviewer report after a reader/validator fix.
 * Only an unchanged report that now validates can wake its same assignment;
 * normal recovery then accepts it without another provider call. Storage faults
 * remain visible, and actual missing evidence never gains acceptance here. */
export async function refreshBlockerReviewerEvidence(job, projectRoot, now) {
  if (job.stage !== "reviewer" || job.status !== "reconciliation_required" || job.reviewer_evidence?.status !== "pending"
    || !["ENOENT", "FILE_NOT_FOUND", "disposition_correction_no_progress"].includes(job.outcome_reason)) return false;
  const attempt = job.disposition_attempts?.findLast((entry) => entry.stage === "reviewer" && entry.status === "rejected");
  if (!attempt?.response?.text || attempt.response.truncated) return false;
  let value;
  try { value = JSON.parse(attempt.response.text); }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }
  try { await validateBlockerReviewerEvidence(value, job, projectRoot); }
  catch (error) { if (error.code === "BLOCKER_DISPOSITION_INVALID") return false; throw error; }
  job.history.push({ stage: "reviewer", event: "reviewer_evidence_validation_refreshed", completed_at: now,
    previous_feedback: job.validation_feedback ?? [], report_sha256: attempt.response.sha256 });
  job.reviewer_evidence.retained_response = { request_id: job.reviewer_evidence.id, sha256: attempt.response.sha256 };
  delete job.validation_feedback;
  return true;
}
