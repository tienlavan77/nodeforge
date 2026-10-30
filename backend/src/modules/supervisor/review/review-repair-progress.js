// Detects accepted implementation findings that were sent back unchanged instead of repaired.
import { createHash } from "node:crypto";

// Compares verified source and durable responses so acknowledgements cannot manufacture review progress through new response IDs.
export async function inspectReviewRepairProgress({ workspace, artifact, findings, result }) {
  if (!workspace.reviewFindings?.load || !result.tool_events?.some((event) => ["report_done", "respond_to_review"].includes(event.name ?? event.tool) && event.status !== "failed")) return null;
  const current = await workspace.testService.assertPassedArtifact();
  if (["artifact_id", "commit_sha", "source_revision", "manifest_sha"].some((key) => current[key] !== artifact[key])) return null;
  const history = await workspace.reviewFindings.load();
  const response = history.coder_responses?.findLast((entry) => entry.artifact_id === artifact.artifact_id
    && entry.review_commit_sha === artifact.commit_sha && entry.source_revision === artifact.source_revision && entry.manifest_sha === artifact.manifest_sha);
  const accepted = findings.filter((finding) => (finding.finding?.files ?? finding.files ?? []).length > 0
    && response?.responses?.some((entry) => entry.finding_id === finding.finding_id && entry.position === "accept"));
  if (!accepted.length) return null;
  const signature = createHash("sha256").update(JSON.stringify({ artifact: artifact.artifact_id, commit: artifact.commit_sha,
    findings: accepted.map((finding) => ({ id: finding.finding_id, definition: finding.finding ?? finding.message })).sort((a, b) => a.id.localeCompare(b.id)) })).digest("hex");
  return { signature, finding_ids: accepted.map((finding) => finding.finding_id),
    instruction: "Your accepted findings remain unresolved on the same verified commit. Continue implementation now: repair the current minimum_change_scope, add focused regressions, commit ticket changes, then report_done on the repaired verified revision. Do not send another acknowledgement or replay the old report. If no implementation change is justified, dispute the finding with distinct concrete evidence instead of accepting an unrepaired defect." };
}
