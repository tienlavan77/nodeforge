// Attributes supplemental regression failures to ticket changes using the same recorded project environment.
import { createHash } from "node:crypto";
import { captureVerificationEnvironment } from "./ticket-verification-environment.js";
import { materializeTicketVerification } from "./ticket-verification-materialization.js";
import { browserCommandOutput } from "../browser/browser-verification-evidence.js";
import { verificationFailureIdentity } from "../verification-failure-identity.js";
import { collectVerificationFailures } from "./ticket-verification-output.js";

// Binds command output and failure identities to their recorded content.
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

// Accepts supplemental failures only when immutable baseline evidence proves the same failure already existed.
export function verificationCommandAccepted(command) {
  if (command.exit_code === 0) return true;
  const baseline = command.baseline;
  return command.scope === "regression" && command.disposition === "preexisting_failure"
    && Boolean(command.failure_sha256) && baseline?.failure_sha256 === command.failure_sha256
    && baseline.exit_code === command.exit_code && Number.isInteger(command.exit_code) && command.exit_code > 0
    && Boolean(baseline.commit_sha) && Boolean(baseline.environment_sha256)
    && JSON.stringify(baseline.argv) === JSON.stringify(command.argv)
    && command.failure_sha256 === regressionFailureIdentity(command, command, command.cwd)
    && baseline.failure_sha256 === regressionFailureIdentity(command, baseline, baseline.cwd)
    && /^sha256:[a-f0-9]{64}$/.test(baseline.output_sha256 ?? "");
}

// Identifies reproducible assertion failures, refusing truncated, cancelled, or transient infrastructure results.
export function regressionFailureIdentity(command, output, cwd) {
  if (!Number.isInteger(output.exit_code) || output.exit_code <= 0) return null;
  // Defines normalize function behavior for ticket-verification-regression.js.
  const normalize = (value) => cwd ? String(value ?? "").split(cwd).join("<verification-root>") : String(value ?? "");
  const stdout = normalize(output.stdout_redacted);
  const stderr = normalize(output.stderr_redacted);
  if (/ENOSPC|no space left on device|ETIMEDOUT|ECONNRESET|cpu overloaded|\b503\b/i.test(`${stdout}\n${stderr}`)) return null;
  if (command.test_paths) {
    let events;
    if (output.failure_evidence) {
      const evidence = output.failure_evidence;
      if (evidence.version !== 1 || evidence.complete !== true || evidence.transient_failure || !Array.isArray(evidence.events)
        || evidence.events.some(event => !event || typeof event !== "object" || !["failure", "summary"].includes(event.type))
        || evidence.visible_output_sha256 !== digest(JSON.stringify([output.stdout_redacted, output.stderr_redacted]))) return null;
      events = evidence.events.map(event => JSON.parse(normalize(JSON.stringify(event))));
    } else {
      try { events = stdout.trim().split("\n").map((line) => JSON.parse(line)); }
      catch (error) { if (error instanceof SyntaxError) return null; throw error; }
    }
    const summary = events.findLast((entry) => entry.type === "summary");
    const failures = events.filter((entry) => entry.type === "failure");
    if (!summary || summary.failed < 1 || summary.cancelled !== 0 || failures.length !== summary.failed || failures.some((entry) => !entry.error?.message)) return null;
    return digest(JSON.stringify(failures.map(verificationFailureIdentity).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
  }
  return stdout.trim() || stderr.trim() ? digest(JSON.stringify([stdout, stderr])) : null;
}

// Runs ticket checks first and compares only failing supplemental checks against the pre-ticket source.
export async function runTicketVerificationCommands({ commands, context, projectRoot, sourceRoot, archive, environment, runCommand, safeOutput, projectLogger, taskId, commandReceipts }) {
  const results = [];
  let baseline;
  let baselineError;
  let snapshot = environment;
  // Records redacted command receipts consistently for ticket and baseline execution.
  async function execute(command, root, tempDir) {
    const started = Date.now();
    const output = browserCommandOutput(command, await runCommand({ ...command, projectRoot, cwd: root, tempDir, timeoutMs: command.kind === "backend_tests" ? 900_000 : 300_000 }));
    const stdout = safeOutput(output.stdout);
    const stderr = safeOutput(output.stderr);
    const evidence = command.test_paths && command.argv.some(arg => arg.includes("ticket-verification-reporter.js"))
      ? output.failure_evidence ?? collectVerificationFailures(output.stdout, output.stderr) : null;
    return { ...command, cwd: root, exit_code: output.exit_code, duration_ms: Date.now() - started, stdout_redacted: stdout, stderr_redacted: stderr,
      ...(evidence ? { failure_evidence: { ...evidence, visible_output_sha256: digest(JSON.stringify([stdout, stderr])) } } : {}),
      ...(output.runtime_environment ? { runtime_environment: output.runtime_environment } : {}),
      ...(output.browser_evidence ? { browser_evidence: output.browser_evidence } : {}),
      output_sha256: output.output_sha256 ?? digest(`${stdout}\0${stderr}`), output_digest_scope: output.output_sha256 ? "full_stream" : "redacted_output" };
  }
  try {
    for (const command of commands) {
      const result = await commandReceipts?.load(command) ?? await execute(command, sourceRoot, archive?.temp_dir);
      if (result.exit_code === 0 && !result.reused_from) await commandReceipts?.save(command, result);
      results.push(result);
      if (command.scope === "regression" && result.exit_code !== 0) {
        result.disposition = "unattributed_failure";
        result.failure_sha256 = regressionFailureIdentity(command, result, sourceRoot);
        try {
          if (result.failure_sha256 && !baselineError) {
            snapshot ??= await captureVerificationEnvironment({ projectRoot: sourceRoot, ticketPaths: context.manifest_paths });
            if (!environment) {
              const reproduction = await materializeTicketVerification({ projectRoot, commitSha: context.review_commit_sha, ticketPaths: context.manifest_paths, environment: snapshot });
              try {
                const receipt = await execute(command, reproduction.path, reproduction.temp_dir);
                await reproduction.assertEnvironment(); await reproduction.assertTicketSource();
                result.reproduction = { ...receipt, commit_sha: context.review_commit_sha, environment_sha256: reproduction.environment.sha256,
                  failure_sha256: regressionFailureIdentity(command, receipt, reproduction.path) };
                if (result.reproduction.failure_sha256 !== result.failure_sha256 || receipt.exit_code !== result.exit_code) throw Object.assign(new Error("Supplemental failure did not reproduce with the captured project environment."), { code: "VERIFY_BASELINE_UNAVAILABLE" });
              } finally { await reproduction.cleanup(); }
            }
            baseline ??= await materializeTicketVerification({ projectRoot, commitSha: context.base_sha, ticketPaths: context.manifest_paths, environment: snapshot });
            const receipt = await execute(command, baseline.path, baseline.temp_dir);
            await baseline.assertEnvironment();
            await baseline.assertTicketSource();
            result.environment_sha256 = snapshot.sha256;
            result.baseline = { ...receipt, commit_sha: context.base_sha, environment_sha256: baseline.environment.sha256,
              failure_sha256: regressionFailureIdentity(command, receipt, baseline.path) };
            if (result.failure_sha256 === result.baseline.failure_sha256 && result.exit_code === receipt.exit_code) result.disposition = "preexisting_failure";
            else result.disposition = receipt.exit_code === 0 ? "introduced_failure" : "changed_failure";
          }
        } catch (error) {
          baselineError = error;
          result.baseline_error = { code: error.code ?? "VERIFY_BASELINE_UNAVAILABLE", message: safeOutput(error.message) };
        }
        projectLogger({ event_name: "ticket.verification_regression", level: verificationCommandAccepted(result) ? "warn" : "error",
          status: verificationCommandAccepted(result) ? "warning" : "failed", task_id: taskId, source: "ticket-verification-service",
          message: verificationCommandAccepted(result) ? "Supplemental verification reproduced a pre-existing baseline failure; ticket acceptance is unchanged." : "Supplemental verification failure requires attribution or repair.",
          payload: { kind: command.kind, test_paths: command.test_paths, disposition: result.disposition, baseline_commit_sha: context.base_sha, baseline_error: result.baseline_error } });
      }
      if (!verificationCommandAccepted(result)) break;
    }
    return results;
  } finally { await baseline?.cleanup(); }
}
