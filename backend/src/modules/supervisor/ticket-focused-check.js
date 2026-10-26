// Runs focused Coder checks against an immutable committed tree or pre-commit working ledger and persists their receipts.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { createHash, randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { validateCheckCommand } from "../../tools/owner-engineer-tools.js";
import { materializeTicketVerification } from "./ticket-verification-materialization.js";
import { captureVerificationEnvironment, restoreVerificationEnvironment } from "./ticket-verification-environment.js";

const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });
const sha = (content) => content === null ? null : `sha256:${createHash("sha256").update(content).digest("hex")}`;

// Binds focused verification to the ticket source identity without changing its acceptance state.
export function createTicketFocusedCheck({ taskId, projectRoot, worktreeFileService, ledger, executionContexts, stateFileService, assertIdentity, assertArchiveSource, runCommand, safeOutput, loadArtifact, materialize = materializeTicketVerification, captureEnvironment = captureVerificationEnvironment, restoreEnvironment = restoreVerificationEnvironment }) {
  // Runs a requested focused check on the recorded commit or pre-commit working ledger without granting final acceptance.
  return async function runCheck({ type, command, signal } = {}) {
    if (!["test", "lint", "typecheck", "build"].includes(type)) throw fail("INPUT_INVALID", "Unknown check type.");
    validateCheckCommand(command, type);
    if (/[^A-Za-z0-9_@./:=*?+\s-]|(?:^|[\s/=])\.\.(?:\/|\s|$)/.test(command)) throw fail("INPUT_INVALID", "Focused check arguments must stay inside the project and use unquoted safe tokens.");
    if (signal?.aborted) throw signal.reason;
    let context = await executionContexts.load(taskId);
    const preCommit = !context?.review_commit_sha;
    let checksums;
    let overlayFiles = null;
    if (preCommit) {
      if (!context?.base_sha || !ledger?.snapshot || !executionContexts?.syncManifest) throw fail("TICKET_COMMIT_REQUIRED", "Commit ticket changes before running a focused check.");
      const manifest = await ledger.snapshot(taskId);
      context = await executionContexts.syncManifest(taskId, manifest);
      checksums = {};
      overlayFiles = {};
      for (const path of context.manifest_paths) {
        let content = null;
        if (worktreeFileService?.readFile) {
          try { content = await worktreeFileService.readFile({ path }); }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        } else {
          content = manifest.entries[path]?.operations?.at(-1)?.after ?? null;
        }
        const checksum = sha(content);
        if (checksum !== manifest.entries[path]?.latest_sha) throw fail("VERIFY_SOURCE_MISMATCH", `Working ledger content differs from manifest: ${path}.`);
        checksums[path] = checksum;
        overlayFiles[path] = content;
      }
    } else {
      checksums = await assertIdentity(context);
    }
    const commitSha = preCommit ? context.base_sha : context.review_commit_sha;
    const artifact = !preCommit && context.verification_artifact_id ? await loadArtifact?.(context.verification_artifact_id) : null;
    if (context.verification_artifact_id && loadArtifact && !artifact) throw fail("VERIFY_CHECK_IDENTITY_MISMATCH", "The recorded verification artifact is missing.");
    if (artifact?.status === "passed" && (artifact.pre_commit === true || artifact.artifact_id !== context.verification_artifact_id || artifact.task_id !== taskId
      || artifact.commit_sha !== context.review_commit_sha || artifact.source_revision !== context.source_revision || artifact.manifest_sha !== context.manifest_sha || !artifact.environment))
      throw fail("VERIFY_CHECK_IDENTITY_MISMATCH", "Focused check differs from the passed verification identity.");
    const environment = artifact?.status === "passed"
      ? await restoreEnvironment(projectRoot, artifact.environment, context.manifest_paths)
      : await captureEnvironment({ projectRoot, ticketPaths: context.manifest_paths });
    const archive = await materialize({ projectRoot, commitSha, ticketPaths: context.manifest_paths, environment, ...(overlayFiles ? { overlayFiles } : {}) });
    try {
      const startedAt = new Date().toISOString();
      const output = await runCommand({ argv: command.trim().split(/\s+/), cwd: archive.path, tempDir: archive.temp_dir, timeoutMs: 120000, signal });
      if (signal?.aborted) throw signal.reason;
      await assertArchiveSource(archive.path, checksums);
      await archive.assertEnvironment?.();
      if (!preCommit) await assertIdentity(context);
      const latest = await executionContexts.load(taskId);
      if (latest.version !== context.version || latest.source_revision !== context.source_revision || latest.review_commit_sha !== context.review_commit_sha) throw fail("VERIFY_CONTEXT_STALE", "Ticket identity changed while the focused check ran.");
      const receipt = { check_id: `CHECK-${randomUUID()}`, task_id: taskId, source_revision: context.source_revision, commit_sha: preCommit ? null : context.review_commit_sha,
        pre_commit: preCommit, environment: archive.environment ?? null, type, command, status: output.exit_code === 0 ? "passed" : "failed", exit_code: output.exit_code,
        stdout: safeOutput(output.stdout), stderr: safeOutput(output.stderr), output_sha256: output.output_sha256,
        started_at: startedAt, completed_at: new Date().toISOString(), changed_paths: context.manifest_paths };
      await stateFileService.atomicWrite({ path: `${statePath()}/ticket-verification/${taskId}/checks/${receipt.check_id}.json`, content: `${JSON.stringify(receipt)}\n`, replace: false });
      return receipt;
    } finally { await archive.cleanup(); }
  }
}
