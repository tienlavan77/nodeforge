// Resumes independent review against passed evidence without adopting mutable Coder workspace changes.
import { isDeepStrictEqual } from "node:util";
import { ConfigurationError } from "../../../shared/errors.js";

// Validates the retained review identity without reclaiming files or refreshing the Coder journal.
export async function prepareTicketReviewContext({ workspace, taskId, supervisorId, ticket, resume }) {
  const context = await workspace?.executionContexts?.load?.(taskId);
  // Keeps all review binding failures explicit instead of refreshing their evidence.
  const invalid = () => Object.assign(new ConfigurationError("Reviewer resume requires the original verified ticket context and artifact."), { code: "REVIEW_EVIDENCE_MISMATCH" });
  if (!context || context.task_id !== taskId || context.project_id !== ticket.project_id || context.supervisor_id !== supervisorId
    || context.base_sha !== workspace.base_commit || !["verified", "reviewing"].includes(context.state)
    || !isDeepStrictEqual(context.verification_plan ?? null, ticket.verification_plan ?? null)) throw invalid();
  const artifact = await workspace.testService.assertPassedArtifact();
  if (!artifact || artifact.status !== "passed" || artifact.artifact_id !== context.verification_artifact_id
    || artifact.commit_sha !== context.review_commit_sha || artifact.source_revision !== context.source_revision
    || artifact.manifest_sha !== context.manifest_sha || artifact.base_sha !== context.base_sha
    || resume.base_commit && resume.base_commit !== context.base_sha
    || resume.verification && ["artifact_id", "commit_sha", "source_revision", "manifest_sha", "base_sha"].some((field) => resume.verification[field] !== artifact[field])) throw invalid();
  await workspace.reportService.assertCoderReport(taskId, ticket);
  return context;
}
