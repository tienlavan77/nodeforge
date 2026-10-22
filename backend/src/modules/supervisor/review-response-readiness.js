// Reports an execution-bound finding-response path without modifying completed reports or review decisions.
import { CODER_TOOL_NAMES } from "../../tools/engineering-tool-catalog.js";

// Proves that the shared Coder catalog and its workspace service can deliver responses on the verified source.
export async function inspectReviewResponseReadiness(workspace, taskId) {
  if (!CODER_TOOL_NAMES.includes("respond_to_review") || !workspace.toolRegistry?.respond_to_review?.execute || !workspace.reviewFindings?.load) return null;
  const context = await workspace.executionContexts.load(taskId);
  if (!["verified", "reviewing"].includes(context?.state) || !context.verification_artifact_id) return null;
  let artifact;
  try { artifact = await workspace.testService.assertPassedArtifact(); }
  catch (error) { return { status: "blocked", code: error.code ?? "VERIFY_ARTIFACT_MISMATCH", message: error.message }; }
  const history = await workspace.reviewFindings.load();
  const report = history.coder_reports?.find((entry) => entry.artifact_id === artifact.artifact_id
    && entry.review_commit_sha === artifact.commit_sha && entry.source_revision === artifact.source_revision && entry.manifest_sha === artifact.manifest_sha);
  if (!report) return null;
  return { status: "available", tool: "respond_to_review", commit_sha: artifact.commit_sha, artifact_id: artifact.artifact_id,
    source_revision: artifact.source_revision, report_id: report.idempotency_key,
    instruction: "The existing completed report is preserved. Resume Coder at its checkpoint and call respond_to_review with the retained artifact/commit/source identity and complete REV responses. Do not rewrite report_done fields or demand new edits/checks/commits solely for this delivery. Node supplies complete history to independent Reviewer using read_file/read_lines." };
}
