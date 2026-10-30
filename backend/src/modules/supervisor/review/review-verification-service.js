/** Executes explicit evidence-only review requests on the original committed ticket
 * and recorded project environment. Durable receipts supplement the original
 * artifact without replacing reports, creating commits, or closing findings. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";
import { loadVerificationEnvironment, readVerificationEnvironmentFile } from "../ticket/ticket-verification-environment.js";
import { materializeTicketVerification } from "../ticket/ticket-verification-materialization.js";
import { runTicketVerificationCommands, verificationCommandAccepted } from "../ticket/ticket-verification-regression.js";
import { assertReviewVerificationRequests } from "./review-verification-contract.js";
import { acquireTicketFileLock } from "../ticket/ticket-file-lock.js";

// Defines digest function behavior for review-verification-service.js.
const digest = (value) => createHash("sha256").update(value).digest("hex");
// Defines fail function behavior for review-verification-service.js.
const fail = (code, message) => Object.assign(new Error(message), { code });

/** Uses existing materialization, command execution, baseline attribution and File
 * Service contracts; repeated or restarted deliveries reuse an exact terminal receipt. */
export function createReviewVerificationService({ taskId, projectId, projectRoot, stateFileService, runCommand, safeOutput,
  projectLogger = () => {}, materialize = materializeTicketVerification }) {
  const active = new Map();
  return async function runReviewVerification({ requests, artifact, executionId, signal, assertActive = () => {} }) {
    assertReviewVerificationRequests(requests, { artifact });
    if (artifact.task_id !== taskId || artifact.project_id !== projectId || !executionId) throw fail("REVIEW_VERIFICATION_SCOPE", "Review verification belongs to another project, ticket or execution.");
    if (!artifact.environment) throw fail("REVIEW_VERIFICATION_ENVIRONMENT_REQUIRED", "Review verification needs the original recorded project environment.");
    const receipts = [];
    for (const request of requests) {
      signal?.throwIfAborted(); await assertActive();
      const identity = { project_id: projectId, task_id: taskId, execution_id: executionId, artifact_id: artifact.artifact_id,
        commit_sha: artifact.commit_sha, source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha,
        environment_sha256: artifact.environment.sha256, finding_ids: [...request.finding_ids].sort(),
        criterion_ids: [...request.criterion_ids].sort(), test_paths: [...request.test_paths].sort(), scope: request.scope,
        ...(request.environment ? { runner_environment: request.environment } : {}) };
      const id = `CHECK-${digest(JSON.stringify(identity))}`;
      if (!active.has(id)) {
        const promise = execute(id, identity, request, artifact, signal, assertActive);
        active.set(id, promise);
        void promise.finally(() => active.delete(id)).catch((error) => projectLogger({ event_name: "review.verification_failed", level: "error", status: "failed",
          task_id: taskId, source: "review-verification-service", message: "Review verification request failed.", error_code: error.code ?? "REVIEW_VERIFICATION_FAILED", payload: { check_id: id } }));
      }
      receipts.push(await active.get(id));
    }
    return receipts;
  };

  /** Persists request intent before execution and the complete receipt before any
   * Reviewer continuation; an interrupted read-only run can be retried after restart. */
  async function execute(id, identity, request, artifact, signal, assertActive) {
    const path = `${statePath("ticket-verification")}/${taskId}/review-checks/${id}.json`;
    const lock = await acquireTicketFileLock(stateFileService, `${path}.lock`);
    let archive;
    try {
      signal?.throwIfAborted(); await assertActive();
      let previous;
      try { previous = JSON.parse(await stateFileService.readFile({ path })); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (previous) {
        if (JSON.stringify(previous.identity) !== JSON.stringify(identity)) throw fail("REVIEW_VERIFICATION_SCOPE", "Review receipt identity conflicts with its request.");
        if (["passed", "failed"].includes(previous.status)) {
          const { receipt_sha256, ...body } = previous;
          if (receipt_sha256 !== digest(JSON.stringify(body))) throw fail("REVIEW_VERIFICATION_RECEIPT_INVALID", "Review receipt checksum changed.");
          return previous;
        }
      }
      const manifest = await loadVerificationEnvironment(projectRoot, artifact.environment);
      const environment = { sha256: artifact.environment.sha256, manifest, files: await Promise.all(manifest.map(async (entry) =>
        ({ ...entry, bytes: await readVerificationEnvironmentFile(projectRoot, entry) }))) };
      const available = new Set([...manifest.map((entry) => entry.path), ...Object.keys(artifact.file_checksums).filter((path) => artifact.file_checksums[path] !== null)]);
      if (request.test_paths.some((path) => !available.has(path))) throw fail("REVIEW_VERIFICATION_TEST_UNAVAILABLE", "Requested tests are absent from the reviewed commit and recorded environment.");
      const startedAt = new Date().toISOString();
      await stateFileService.atomicWrite({ path, content: `${JSON.stringify({ check_id: id, identity, request, status: "running", started_at: startedAt })}\n`, replace: true });
      log("started", id, identity);
      archive = await materialize({ projectRoot, commitSha: artifact.commit_sha, ticketPaths: Object.keys(artifact.file_checksums), environment });
      if (archive.environment?.sha256 !== artifact.environment.sha256) throw fail("REVIEW_VERIFICATION_ENVIRONMENT_REQUIRED", "Materialized environment differs from the reviewed artifact.");
      await assertSource(archive.path, artifact.file_checksums);
      const context = { base_sha: artifact.base_sha, review_commit_sha: artifact.commit_sha, manifest_paths: Object.keys(artifact.file_checksums) };
      const commands = [{ kind: "backend_tests", scope: request.scope, reason: request.reason, test_paths: identity.test_paths,
        criterion_ids: identity.criterion_ids, environment: request.environment, argv: [process.execPath, "--test", `--test-reporter=${fileURLToPath(new URL("../ticket/ticket-verification-reporter.js", import.meta.url))}`, ...identity.test_paths] }];
      const results = await runTicketVerificationCommands({ commands, context, projectRoot, sourceRoot: archive.path, archive, environment,
        runCommand: async (input) => { signal?.throwIfAborted(); await assertActive(); return runCommand({ ...input, signal, projectRoot }); },
        safeOutput, projectLogger, taskId });
      signal?.throwIfAborted(); await assertActive();
      let integrityError = null;
      try { await assertSource(archive.path, artifact.file_checksums); await archive.assertEnvironment(); }
      catch (error) {
        if (!["VERIFY_SOURCE_MISMATCH", "VERIFY_ENVIRONMENT_CHANGED"].includes(error.code)) throw error;
        integrityError = { code: error.code, message: error.message, phase: "after_checks",
          ...(error.path ? { path: error.path, expected_sha256: error.expected_sha256, observed_sha256: error.observed_sha256 } : {}) };
      }
      const receipt = { check_id: id, identity, request, task_id: taskId, project_id: projectId, execution_id: identity.execution_id,
        artifact_id: artifact.artifact_id, commit_sha: artifact.commit_sha, source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha,
        pre_commit: false, environment: artifact.environment, finding_ids: identity.finding_ids, criterion_ids: identity.criterion_ids,
        status: !integrityError && results.length === 1 && results.every(verificationCommandAccepted) ? "passed" : "failed", commands: results,
        ...(integrityError ? { integrity_error: integrityError } : {}),
        started_at: startedAt, completed_at: new Date().toISOString() };
      await stateFileService.atomicWrite({ path, content: `${JSON.stringify({ ...receipt, receipt_sha256: digest(JSON.stringify(receipt)) })}\n`, replace: true });
      log(receipt.status, id, identity);
      return { ...receipt, receipt_sha256: digest(JSON.stringify(receipt)) };
    } finally { try { await archive?.cleanup(); } finally { await lock.release(); } }
  }

  /** Sends lifecycle events to the existing terminal/stream logger without emitting repeated wait messages. */
  function log(status, id, identity) {
    projectLogger({ event_name: `review.verification_${status}`, source: "review-verification-service", level: status === "failed" ? "warn" : "info",
      status: status === "passed" ? "success" : status, message: `Node review verification ${status}; ${status === "started" ? "Reviewer will continue when checks finish" : "returning evidence to Reviewer"}.`,
      task_id: taskId, payload: { check_id: id, commit_sha: identity.commit_sha, finding_ids: identity.finding_ids, test_paths: identity.test_paths } });
  }
}

/** Checks every ticket-owned byte before and after checks; an isolated test cannot
 * manufacture evidence by rewriting the reviewed source or restoring a different revision. */
async function assertSource(root, checksums) {
  for (const [path, checksum] of Object.entries(checksums)) {
    let bytes = null;
    try { bytes = await readFile(join(root, path)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const observed = bytes === null ? null : `sha256:${digest(bytes)}`;
    if (observed !== checksum) throw Object.assign(fail("VERIFY_SOURCE_MISMATCH", `Review verification source differs: ${path}.`),
      { path, expected_sha256: checksum, observed_sha256: observed });
  }
}
