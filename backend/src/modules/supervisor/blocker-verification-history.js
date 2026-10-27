// Delivers current and historical verification receipts for attribution without promoting historical results to acceptance.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { statePath, resolveRuntimePath } from "../../infrastructure/filesystem/forge-paths.js";
import { createFileService } from "../../infrastructure/filesystem/file-service.js";
import { createRoleFileService } from "../../infrastructure/filesystem/file-service-role-policy.js";
import { BLOCKER_RECEIPT_MAX_BYTES } from "./blocker-evidence-limits.js";

// Retains the start and terminal failure details while limiting inline diagnostic output; exact receipts remain readable by reference.
export function boundedVerificationOutput(value) {
  const text = String(value ?? "");
  return text.length <= 4000 ? text : `${text.slice(0, 2000)}\n[output truncated]\n${text.slice(-2000)}`;
}

// Enumerates only Node receipt namespaces, distinguishing absent evidence from storage errors.
async function receiptNames(root, directory, pattern) {
  try { return (await readdir(join(root, directory))).filter((name) => pattern.test(name)).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

// Reads ticket history through the internal path policy so symlinks, cross-project records and mismatched filenames cannot grant evidence access.
export async function readBlockerVerificationHistory({ job, workspace, context, checkpoint }) {
  const taskId = context.task_id;
  const prefix = `${statePath()}/ticket-verification/${taskId}`;
  const projectRoot = workspace.projectRoot ?? workspace.path;
  const root = resolveRuntimePath(projectRoot, prefix);
  const files = createRoleFileService({ projectRoot, role: "system_engineer", fileService: createFileService({ projectRoot, role: "system_engineer" }) });
  const current = [], historical = [], artifacts = [], jobs = [], receipt_index = [];
  const baseline = [];
  const requested = new Set(JSON.stringify(job.resolution?.reconciliation ?? {}).match(/(?:CHECK|ARTIFACT)-[A-Za-z0-9-]+/g) ?? []);
  const wait = checkpoint?.verification_wait;
  const retained = wait?.task_id === taskId && /^VERIFY-[A-Za-z0-9-]+$/.test(wait.job_id ?? "") ? wait : null;
  if (retained) requested.add(retained.job_id);
  const counts = { checks: 0, artifacts: 0 };
  for (const [directory, key, pattern] of [["jobs", "job_id", /^VERIFY-[A-Za-z0-9-]+\.json$/],
    ["checks", "check_id", /^CHECK-[A-Za-z0-9-]+\.json$/], ["artifacts", "artifact_id", /^ARTIFACT-[A-Za-z0-9-]+\.json$/]]) {
    for (const name of await receiptNames(root, directory, pattern)) {
      const path = `${prefix}/${directory}/${name}`;
      let file;
      try { file = await files.readForIndex({ path, maxBytes: BLOCKER_RECEIPT_MAX_BYTES }); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const receipt = JSON.parse(file.content);
      if (receipt.task_id !== taskId || `${receipt[key]}.json` !== name || !receipt.source_revision
        || receipt.commit_sha === undefined || receipt.project_id !== undefined && receipt.project_id !== context.project_id
        || directory === "artifacts" && receipt.project_id !== context.project_id) continue;
      if (directory !== "jobs") counts[directory] += 1;
      const matches = receipt.source_revision === context.source_revision && receipt.commit_sha === context.review_commit_sha;
      const entry = { [key]: receipt[key], status: receipt.status, source_revision: receipt.source_revision, commit_sha: receipt.commit_sha,
        pre_commit: receipt.pre_commit === true, environment: receipt.environment ?? null, completed_at: receipt.completed_at,
        evidence_ref: path, receipt_sha256: file.sha256, provenance: matches ? "current_source" : "historical_ticket_source", diagnostic_only: true };
      receipt_index.push({ ...entry, type: directory });
      if (directory === "jobs") {
        Object.assign(entry, { artifact_id: receipt.artifact_id, error: receipt.error, started_at: receipt.started_at,
          finished_at: receipt.finished_at, attempt: receipt.attempt, runner_revision: receipt.runner_revision });
        jobs.push(entry);
        if (retained?.job_id === receipt.job_id && retained.commit_sha === receipt.commit_sha && retained.source_revision === receipt.source_revision
          && /^ARTIFACT-[A-Za-z0-9-]+$/.test(receipt.artifact_id ?? "")) requested.add(receipt.artifact_id);
      }
      if (directory === "artifacts") {
        artifacts.push({ ...entry, commands: (receipt.commands ?? []).map(({ kind, argv, exit_code, scope, disposition, criterion_ids, reason }) =>
          ({ kind, argv, exit_code, scope, disposition, criterion_ids, reason })) });
      }
      if (directory === "checks") {
        Object.assign(entry, { type: receipt.type, command: receipt.command, exit_code: receipt.exit_code,
          stdout: boundedVerificationOutput(receipt.stdout), stderr: boundedVerificationOutput(receipt.stderr) });
        (matches ? current : historical).push(entry);
      }
      const commands = directory === "checks" ? [receipt] : receipt.commands ?? [];
      const recorded = commands.filter((command) => command.baseline).map((command) => ({ command: command.command ?? command.argv,
        baseline: command.baseline, baseline_error: command.baseline_error ?? null }));
      if (recorded.length) {
        baseline.push({ evidence_ref: path, source_revision: receipt.source_revision, commit_sha: receipt.commit_sha,
          environment_sha256: receipt.environment?.sha256 ?? null, commands: recorded.map(({ command, baseline: result, baseline_error }) => ({ command,
            baseline: { ...result, stdout: undefined, stderr: undefined, stdout_redacted: boundedVerificationOutput(result.stdout_redacted ?? result.stdout),
              stderr_redacted: boundedVerificationOutput(result.stderr_redacted ?? result.stderr) }, baseline_error })) });
      }
    }
  }
  // Prioritizes explicitly requested receipts and failures over successful incidental checks, with deterministic bounded handoff sizes.
  const select = (entries, limit) => entries.sort((a, b) => Number(requested.has(b.check_id ?? b.job_id ?? b.artifact_id)) - Number(requested.has(a.check_id ?? a.job_id ?? a.artifact_id))
    || Number(b.status === "failed") - Number(a.status === "failed") || String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? ""))
    || a.evidence_ref.localeCompare(b.evidence_ref)).slice(0, limit);
  const retainedJob = retained && jobs.find((entry) => entry.job_id === retained.job_id && entry.commit_sha === retained.commit_sha && entry.source_revision === retained.source_revision);
  const retainedArtifact = retainedJob && artifacts.find((entry) => entry.artifact_id === retainedJob.artifact_id
    && entry.commit_sha === retainedJob.commit_sha && entry.source_revision === retainedJob.source_revision);
  return { checks: select(current, 8), historical_checks: select(historical, 8), historical_artifacts: select(artifacts, 8),
    historical_jobs: select(jobs, 8), receipt_index,
    retained_attempt: retained ? { status: retainedJob ? "observed" : "not_recorded", selection: "checkpoint.verification_wait", diagnostic_only: true,
      job: retainedJob || null, artifact: retainedArtifact || null } : null,
    baseline_evidence: { status: baseline.length ? "recorded" : "not_recorded", searched: counts,
      receipts: baseline.slice(0, 8), total: baseline.length,
      notice: "Inventory of retained ticket check/artifact receipts only. Missing baseline evidence does not establish a preexisting failure. When runtime_capabilities.baseline_recovery is installed, Node executes recorded-environment recovery before consultation and delivers its receipt; consume that result instead of requesting an external operator or an unrecorded historical result. Actual tool denials remain enforced." } };
}
