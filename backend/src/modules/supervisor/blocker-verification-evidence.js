// Supplies retained verification diagnostics to SL without granting runtime file tools or changing acceptance.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { latestTicketVerificationAttempt } from "./ticket-verification-attempts.js";
import { inspectVerificationSource } from "./blocker-verification-source.js";
import { createTicketVerificationDiagnostic } from "./ticket-verification-diagnostic.js";

// Reads only the current ticket's source-bound jobs and checks, including evidence from an earlier runner version.
export async function readBlockerVerificationEvidence({ job, workspace, context }) {
  const taskId = job.request.task_id;
  if (!/^[A-Za-z0-9._:-]+$/.test(taskId ?? "") || taskId === "." || taskId === "..") throw new Error("Invalid recovery ticket identity.");
  if (context?.task_id !== taskId || !context?.project_id || !job.request.project_id || context.project_id !== job.request.project_id
    || !(workspace.projectRoot ?? workspace.path)) return { status: "unavailable", reason: "Current project identity is missing or changed." };
  const root = join(workspace.projectRoot ?? workspace.path, ".forge/runtime/ticket-verification", taskId);
  const latest = await latestTicketVerificationAttempt({ projectRoot: workspace.projectRoot ?? workspace.path, taskId, context,
    matchRunnerRevision: false, loadJob: (id) => readJson(join(root, "jobs", `${id}.json`)) });
  const bound = latest && latest.task_id === taskId && latest.commit_sha === context.review_commit_sha && latest.source_revision === context.source_revision;
  const diagnostic = bound ? await createTicketVerificationDiagnostic({ loadContext: () => workspace.executionContexts.load(taskId),
    latestJob: async () => latest, loadArtifact: (id) => {
      if (!/^ARTIFACT-[A-Za-z0-9-]+$/.test(id)) throw new Error("Invalid recovery artifact identity.");
      return readJson(join(root, "artifacts", `${id}.json`));
    } })() : null;
  const checks = [];
  for (const name of (await names(join(root, "checks"))).filter((name) => /^CHECK-[A-Za-z0-9-]+\.json$/.test(name))) {
    const check = await readJson(join(root, "checks", name));
    if (check?.task_id !== taskId || check.source_revision !== context.source_revision || check.commit_sha !== context.review_commit_sha) continue;
    checks.push({ check_id: check.check_id, status: check.status, type: check.type, command: check.command,
      exit_code: check.exit_code, completed_at: check.completed_at, source_revision: check.source_revision, commit_sha: check.commit_sha,
      stdout: bounded(check.stdout), stderr: bounded(check.stderr), evidence_ref: `.forge/runtime/ticket-verification/${taskId}/checks/${name}` });
  }
  const source_composition = bound && diagnostic ? await inspectVerificationSource({ projectRoot: workspace.projectRoot ?? workspace.path, context, diagnostic }) : null;
  const current = await workspace.executionContexts.load(taskId);
  if (["version", "source_revision", "review_commit_sha", "manifest_sha", "base_sha", "project_id"].some((key) => current?.[key] !== context[key]))
    return { status: "unavailable", reason: "Verification source changed during evidence collection." };
  return { source_composition, status: bound ? "observed" : "missing", source_revision: context.source_revision, commit_sha: context.review_commit_sha,
    job: bound ? { job_id: latest.job_id, status: latest.status, attempt: latest.attempt, artifact_id: latest.artifact_id,
      runner_revision: latest.runner_revision ?? null, error: latest.error, started_at: latest.started_at, finished_at: latest.finished_at,
      breakdown: latest.result?.breakdown, evidence_ref: `.forge/runtime/ticket-verification/${taskId}/jobs/${latest.job_id}.json` } : null,
    diagnostic: diagnostic ? { ...diagnostic, commands: diagnostic.commands?.map((command) => ({ ...command,
      stdout_redacted: bounded(command.stdout_redacted), stderr_redacted: bounded(command.stderr_redacted) })) } : null,
    checks: checks.sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at))).slice(0, 3),
    notice: "Read-only diagnostic evidence for the retained source. This does not grant acceptance, tool access or approval; unknown or denied operations remain gated." };
}

// Preserves the start and end of redacted output so both command setup and terminal failures remain visible.
function bounded(value) {
  const text = String(value ?? "");
  return text.length <= 4000 ? text : `${text.slice(0, 2000)}\n[output truncated]\n${text.slice(-2000)}`;
}

// Distinguishes absent historical evidence from storage or malformed-JSON errors requiring reconciliation.
async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Treats a ticket without focused checks as missing evidence without swallowing filesystem faults.
async function names(path) {
  try { return await readdir(path); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
