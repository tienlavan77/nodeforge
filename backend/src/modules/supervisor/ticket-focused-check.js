// Runs focused Coder checks against an immutable committed tree and persists their receipts.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { validateCheckCommand } from "../../tools/owner-engineer-tools.js";
import { materializeTicketArchive } from "./ticket-archive-materialization.js";

const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Binds focused verification to the ticket source identity without changing its acceptance state.
export function createTicketFocusedCheck({ taskId, projectRoot, executionContexts, stateFileService, assertIdentity, assertArchiveSource, runCommand, safeOutput, materialize = materializeTicketArchive }) {
  // Runs a requested focused check on the recorded commit without granting final acceptance.
  return async function runCheck({ type, command, signal } = {}) {
    if (!["test", "lint", "typecheck", "build"].includes(type)) throw fail("INPUT_INVALID", "Unknown check type.");
    validateCheckCommand(command, type);
    if (/[^A-Za-z0-9_@./:=*?+\s-]|(?:^|[\s/=])\.\.(?:\/|\s|$)/.test(command)) throw fail("INPUT_INVALID", "Focused check arguments must stay inside the project and use unquoted safe tokens.");
    if (signal?.aborted) throw signal.reason;
    const context = await executionContexts.load(taskId);
    if (!context?.review_commit_sha) throw fail("TICKET_COMMIT_REQUIRED", "Commit ticket changes before running a focused check.");
    const checksums = await assertIdentity(context);
    const archive = await materialize({ projectRoot, commitSha: context.review_commit_sha });
    try {
      const startedAt = new Date().toISOString();
      const output = await runCommand({ argv: command.trim().split(/\s+/), cwd: archive.path, tempDir: archive.temp_dir, timeoutMs: 120000, signal });
      if (signal?.aborted) throw signal.reason;
      await assertArchiveSource(archive.path, checksums);
      await assertIdentity(context);
      const latest = await executionContexts.load(taskId);
      if (latest.version !== context.version || latest.source_revision !== context.source_revision || latest.review_commit_sha !== context.review_commit_sha) throw fail("VERIFY_CONTEXT_STALE", "Ticket identity changed while the focused check ran.");
      const receipt = { check_id: `CHECK-${randomUUID()}`, task_id: taskId, source_revision: context.source_revision, commit_sha: context.review_commit_sha,
        type, command, status: output.exit_code === 0 ? "passed" : "failed", exit_code: output.exit_code,
        stdout: safeOutput(output.stdout), stderr: safeOutput(output.stderr), output_sha256: output.output_sha256,
        started_at: startedAt, completed_at: new Date().toISOString(), changed_paths: context.manifest_paths };
      await stateFileService.atomicWrite({ path: `.forge/runtime/ticket-verification/${taskId}/checks/${receipt.check_id}.json`, content: `${JSON.stringify(receipt)}\n`, replace: false });
      return receipt;
    } finally { await archive.cleanup(); }
  }
}
