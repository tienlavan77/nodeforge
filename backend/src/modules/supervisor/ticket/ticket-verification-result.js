/** Projects Node-owned verification receipts into repair-only agent responses.
 * Full command evidence remains immutable in storage; routine passing logs and
 * accepted baseline regressions never consume the Coder's repair context. */
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";
import { verificationCommandAccepted } from "./ticket-verification-regression.js";

/** Keeps the beginning and terminal cause of an already-redacted error without
 * returning the successful portions of an entire verification transcript. */
function bounded(value, limit = 8000) {
  const text = String(value ?? "");
  const marker = "\n[output truncated]\n";
  return text.length <= limit ? text : `${text.slice(0, limit / 2)}${marker}${text.slice(-(limit - limit / 2 - marker.length))}`;
}

/** Extracts only assertion failures from structured Node output. Legacy plain
 * diagnostics remain available for lint, compilation and runner failures. */
function failureOutput(command) {
  const failures = command.failure_evidence?.events?.filter(entry => entry.type === "failure") ?? [];
  if (!failures.length) {
    for (const line of String(command.stdout_redacted ?? "").split("\n")) {
      let entry;
      try { entry = JSON.parse(line); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; continue; }
      if (entry?.type === "failure") failures.push(entry);
    }
  }
  if (!failures.length) return command.stdout_redacted ?? "";
  return failures.map(entry => JSON.stringify({ name: entry.name, file: entry.file, line: entry.line, column: entry.column,
    error: Object.fromEntries(Object.entries(entry.error ?? {}).map(([key, value]) => [key,
      typeof value === "string" ? bounded(value, 1600) : value])) })).join("\n");
}

/** Sends only failures that still block this ticket, preserving exact command,
 * acceptance mapping and receipt identities so Coder repairs the right scope. */
export function verificationFailureCommands(commands = []) {
  return commands.filter(command => !verificationCommandAccepted(command)).map(command => {
    const stdout = failureOutput(command), stderr = command.stderr_redacted;
    return { kind: command.kind, argv: command.argv, exit_code: command.exit_code, blocking: true,
      ...(command.test_paths ? { test_paths: command.test_paths } : {}),
      ...(command.scope ? { scope: command.scope, disposition: command.disposition, criterion_ids: command.criterion_ids, reason: command.reason } : {}),
      ...(command.baseline ? { baseline: { commit_sha: command.baseline.commit_sha, exit_code: command.baseline.exit_code, failure_sha256: command.baseline.failure_sha256 } } : {}),
      ...(command.baseline_error ? { baseline_error: command.baseline_error } : {}),
      stdout_redacted: bounded(stdout), stderr_redacted: bounded(stderr),
      output_truncated: String(stdout ?? "").length > 8000 || String(stderr ?? "").length > 8000 };
  });
}

/** Returns terminal status and immutable evidence references without duplicating
 * passing logs or full per-command receipts in SDK tool responses and polling. */
export function ticketVerificationResult(job, artifact) {
  const result = Object.fromEntries(["job_id", "task_id", "attempt", "status", "artifact_id", "commit_sha", "source_revision", "started_at", "finished_at", "error"]
    .filter(key => job[key] !== undefined).map(key => [key, job[key]]));
  if (job.result) result.result = { status: job.result.status, ready_for_review: job.result.ready_for_review,
    commit_id: job.result.commit_id, artifact_id: job.result.artifact_id };
  if (artifact) {
    result.evidence_ref = `${statePath("ticket-verification")}/${job.task_id}/artifacts/${artifact.artifact_id}.json`;
    result.commands = job.status === "failed" ? verificationFailureCommands(artifact.commands) : [];
  }
  return result;
}

/** Preserves focused-check identity and environment while omitting passing
 * command output when an agent looks up a previously issued check receipt. */
export function ticketFocusedCheckResult(check) {
  const { stdout, stderr, ...metadata } = check;
  delete metadata.failure_evidence;
  const failed = check.status === "failed";
  return { ...metadata, job_id: check.check_id, stdout_redacted: failed ? bounded(failureOutput({ ...check, stdout_redacted: stdout })) : "",
    stderr_redacted: failed ? bounded(stderr) : "" };
}
