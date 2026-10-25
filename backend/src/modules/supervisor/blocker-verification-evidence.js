// Supplies retained verification diagnostics to SL without granting runtime file tools or changing acceptance.
import { readBlockerVerificationHistory, boundedVerificationOutput as bounded } from "./blocker-verification-history.js";
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { latestTicketVerificationAttempt } from "./ticket-verification-attempts.js";
import { inspectVerificationSource } from "./blocker-verification-source.js";
import { createTicketVerificationDiagnostic } from "./ticket-verification-diagnostic.js";

// Reads only the current ticket's source-bound jobs and checks, including evidence from an earlier runner version.
export async function readBlockerVerificationEvidence({ job, workspace, context, checkpoint }) {
  const taskId = job.request.task_id;
  if (!/^[A-Za-z0-9._:-]+$/.test(taskId ?? "") || taskId === "." || taskId === "..") throw new Error("Invalid recovery ticket identity.");
  if (context?.task_id !== taskId || !context?.project_id || !job.request.project_id || context.project_id !== job.request.project_id
    || !(workspace.projectRoot ?? workspace.path)) return { status: "unavailable", reason: "Current project identity is missing or changed." };
  const root = join(workspace.projectRoot ?? workspace.path, statePath("ticket-verification"), taskId);
  const latest = await latestTicketVerificationAttempt({ projectRoot: workspace.projectRoot ?? workspace.path, taskId, context,
    matchRunnerRevision: false, loadJob: (id) => readJson(join(root, "jobs", `${id}.json`)) });
  const bound = latest && latest.task_id === taskId && latest.commit_sha === context.review_commit_sha && latest.source_revision === context.source_revision;
  const diagnostic = bound ? await createTicketVerificationDiagnostic({ loadContext: () => workspace.executionContexts.load(taskId),
    latestJob: async () => latest, loadArtifact: (id) => {
      if (!/^ARTIFACT-[A-Za-z0-9-]+$/.test(id)) throw new Error("Invalid recovery artifact identity.");
      return readJson(join(root, "artifacts", `${id}.json`));
    } })() : null;
  const history = await readBlockerVerificationHistory({ job, workspace, context, checkpoint });
  const source_composition = bound && diagnostic ? await inspectVerificationSource({ projectRoot: workspace.projectRoot ?? workspace.path, context, diagnostic }) : null;
  const current = await workspace.executionContexts.load(taskId);
  if (["version", "source_revision", "review_commit_sha", "manifest_sha", "base_sha", "project_id"].some((key) => current?.[key] !== context[key]))
    return { status: "unavailable", reason: "Verification source changed during evidence collection." };
  return { source_composition, status: bound ? "observed" : "missing", source_revision: context.source_revision, commit_sha: context.review_commit_sha,
    job: bound ? { job_id: latest.job_id, status: latest.status, attempt: latest.attempt, artifact_id: latest.artifact_id,
      runner_revision: latest.runner_revision ?? null, error: latest.error, started_at: latest.started_at, finished_at: latest.finished_at,
      breakdown: latest.result?.breakdown, evidence_ref: `${statePath()}/ticket-verification/${taskId}/jobs/${latest.job_id}.json` } : null,
    diagnostic: diagnostic ? { ...diagnostic, commands: diagnostic.commands?.map((command) => ({ ...command,
      stdout_redacted: bounded(command.stdout_redacted), stderr_redacted: bounded(command.stderr_redacted) })) } : null,
    ...history,
    notice: "Read-only diagnostic evidence for the retained source. This does not grant acceptance, tool access or approval; unknown or denied operations remain gated." };
}

// Distinguishes absent historical evidence from storage or malformed-JSON errors requiring reconciliation.
async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
