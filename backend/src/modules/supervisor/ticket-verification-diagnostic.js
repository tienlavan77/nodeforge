// Carries immutable command evidence into Coder repair without mistaking infrastructure faults for code defects.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { verificationCommandAccepted } from "./ticket-verification-regression.js";

// Loads the latest failed artifact only when its complete source identity still matches the ticket context.
export function createTicketVerificationDiagnostic({ loadContext, latestJob, loadArtifact }) {
  // Restores failed-command guidance from immutable evidence for dispatch and checkpoint resume.
  return async function getFailureDiagnostic() {
    const context = await loadContext();
    if (!context) return null;
    const job = await latestJob(context);
    if (job?.status !== "failed") return null;
    if (!job.artifact_id) return { repairable: false, reason: job.error?.code ?? "VERIFY_DIAGNOSTIC_MISSING", job_id: job.job_id, diagnostic_unavailable: "No immutable command artifact was written." };
    const artifact = await loadArtifact(job.artifact_id);
    const current = await loadContext();
    if (!artifact || current?.version !== context.version || artifact.status !== "failed"
      || artifact.task_id !== context.task_id || artifact.project_id !== context.project_id
      || artifact.commit_sha !== context.review_commit_sha || artifact.source_revision !== context.source_revision
      || artifact.base_sha !== context.base_sha || artifact.manifest_sha !== context.manifest_sha) {
      return { repairable: false, reason: "VERIFY_SOURCE_STALE", diagnostic_unavailable: "Latest failed artifact does not match the current ticket identity." };
    }
    const commands = (artifact.commands ?? []).map((command) => ({
      kind: command.kind, argv: command.argv, exit_code: command.exit_code, blocking: !verificationCommandAccepted(command),
      ...(command.scope ? { scope: command.scope, disposition: command.disposition, criterion_ids: command.criterion_ids, reason: command.reason } : {}),
      ...(command.baseline ? { baseline: { commit_sha: command.baseline.commit_sha, exit_code: command.baseline.exit_code, failure_sha256: command.baseline.failure_sha256 } } : {}),
      ...(command.baseline_error ? { baseline_error: command.baseline_error } : {}), stdout_redacted: bounded(command.stdout_redacted), stderr_redacted: bounded(command.stderr_redacted),
      output_truncated: String(command.stdout_redacted ?? "").length > 8000 || String(command.stderr_redacted ?? "").length > 8000
    }));
    return { repairable: job.error?.code === "VERIFY_COMMAND_FAILED" && commands.some((command) => command.blocking && Number.isInteger(command.exit_code) && command.exit_code !== 0),
      repair_guidance: "Repair blocking ticket checks or introduced/changed regressions. Do not repair supplemental preexisting_failure checks for this ticket. Unattributed failures require baseline evidence before assigning responsibility.",
      reason: job.error?.code ?? "VERIFY_DIAGNOSTIC_MISSING", job_id: job.job_id, artifact_id: artifact.artifact_id,
      task_id: artifact.task_id, project_id: artifact.project_id, source_revision: artifact.source_revision,
      commit_sha: artifact.commit_sha, base_sha: artifact.base_sha, manifest_sha: artifact.manifest_sha,
      evidence_ref: `${statePath()}/ticket-verification/${artifact.task_id}/artifacts/${artifact.artifact_id}.json`, commands };
  };
}

// Bounds already-redacted output while retaining the durable artifact reference for full diagnostics.
function bounded(value) { return String(value ?? "").slice(0, 8000); }
