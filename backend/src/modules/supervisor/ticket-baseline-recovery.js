/** Completes Node-owned regression attribution from a failed immutable artifact.
 * Recovery restores the recorded environment, reruns the unresolved plan suffix,
 * and publishes new evidence without editing ticket source or replaying passing checks. */
import { createHash } from "node:crypto";
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { acquireTicketFileLock } from "./ticket-file-lock.js";
import { restoreVerificationEnvironment } from "./ticket-verification-environment.js";
import { materializeTicketVerification } from "./ticket-verification-materialization.js";
import { runTicketVerificationCommands, verificationCommandAccepted } from "./ticket-verification-regression.js";
import { ticketVerificationRunnerRevision } from "./ticket-verification-runner-revision.js";
import { coversVerificationPolicy } from "./ticket-verification-policy.js";

/** Rejects changed execution evidence rather than deriving authority from agent prose. */
const fail = (message) => Object.assign(new Error(message), { code: "VERIFY_BASELINE_RECOVERY_INVALID" });
/** Names evidence deterministically so duplicate delivery and restart share one result. */
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Compares only execution inputs; output and timing never select additional tests. */
const commandIdentity = (command) => JSON.stringify([command.kind, command.argv, command.scope, command.test_paths,
  command.criterion_ids, command.reason, command.environment]);

/** Builds a source-bound continuation using Node's recorded failure, never an
 * arbitrary command supplied by SL, AM, or a free-text diagnostic. */
export function baselineRecoveryRequest(artifact, context, { taskId, projectId, policyVersion }) {
  if (!artifact || artifact.status !== "failed" || artifact.pre_commit === true || !artifact.environment
    || artifact.policy_version !== policyVersion || artifact.task_id !== taskId || artifact.project_id !== projectId
    || context.task_id !== taskId || context.project_id !== projectId
    || ["source_revision", "manifest_sha", "base_sha"].some(key => artifact[key] !== context[key])
    || artifact.commit_sha !== context.review_commit_sha || !artifact.commit_sha) throw fail("Baseline recovery source or environment is missing or stale.");
  const commands = artifact.commands;
  const planned = artifact.planned_commands;
  const index = Array.isArray(commands) ? commands.findIndex(command => !verificationCommandAccepted(command)) : -1;
  if (!Array.isArray(planned) || !planned.length || !Array.isArray(commands) || !commands.length || commands.length > planned.length || index !== commands.length - 1
    || commands.some((command, i) => commandIdentity(command) !== commandIdentity(planned[i])))
    throw fail("Baseline recovery requires the exact executed prefix of the original verification plan.");
  if (commands[index].scope !== "regression" || commands[index].disposition !== "unattributed_failure")
    throw fail("Baseline recovery cannot clear an acceptance failure or an attributed regression.");
  return { original_artifact_id: artifact.baseline_recovery?.original_artifact_id ?? artifact.artifact_id,
    artifact_id: artifact.artifact_id, commit_sha: artifact.commit_sha, base_sha: artifact.base_sha,
    source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha,
    environment_sha256: artifact.environment.sha256, from_command: index, commands: planned.slice(index) };
}

/** Reuses the ordinary isolated runner and final policy gate. Partial persistence
 * resumes at publication; an unchanged terminal failure is returned without another run. */
export function createTicketBaselineRecovery({ taskId, projectId, projectRoot, stateFileService, loadContext, updateContext,
  latestJob, loadArtifact, saveArtifact, saveJob, assertIdentity, policyVersion, runCommand, safeOutput, projectLogger = () => {},
  materialize = materializeTicketVerification, restoreEnvironment = restoreVerificationEnvironment,
  runnerRevision = ticketVerificationRunnerRevision, runCommands = runTicketVerificationCommands }) {
  let active;
  let activeExecution;
  return async (options = {}) => {
    if (active) {
      if (activeExecution !== options.executionId) throw fail("Another execution owns baseline recovery.");
      return active;
    }
    activeExecution = options.executionId;
    active = recover(options);
    try { return await active; } finally { active = null; }
  };
  /** Keeps one file lock across execution and publication, independent of agent occupancy. */
  async function recover({ executionId, signal, assertActive = () => {} }) {
    if (!executionId) throw fail("Baseline recovery requires an execution identity.");
    /** Rechecks Stop and the owning recovery reservation at every command and persistence boundary. */
    const checkActive = async () => { signal?.throwIfAborted(); await assertActive(); };
    await checkActive();
    const context = await loadContext();
    const previous = await latestJob(context);
    if (previous?.status !== "failed" || previous.error?.code !== "VERIFY_BASELINE_UNAVAILABLE" || !previous.artifact_id) return null;
    const original = await loadArtifact(previous.artifact_id);
    const request = baselineRecoveryRequest(original, context, { taskId, projectId, policyVersion });
    const runner = await runnerRevision(context.verification_plan, { environment: context.verification_runner_environment });
    if (original.baseline_recovery && original.baseline_recovery.execution_id !== executionId) throw fail("Baseline recovery belongs to a different execution.");
    if (original.baseline_recovery?.runner_revision === runner) return { status: original.status, artifact_id: original.artifact_id,
      job_id: previous.job_id, reused: true, error: previous.error };
    const identity = { project_id: projectId, task_id: taskId, execution_id: executionId, request, runner_revision: runner };
    const id = digest(identity);
    const path = `${statePath("ticket-verification")}/${taskId}/checks/CHECK-BASELINE-${id}.json`;
    const lock = await acquireTicketFileLock(stateFileService, `${path}.lock`);
    let archive;
    try {
      await checkActive(); await assertContext(context);
      if (JSON.stringify(await assertIdentity(context)) !== JSON.stringify(original.file_checksums)) throw fail("Baseline recovery source checksums differ from the recorded artifact.");
      let intent;
      try { intent = JSON.parse(await stateFileService.readFile({ path })); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (intent && JSON.stringify(intent.identity) !== JSON.stringify(identity)) throw fail("Baseline recovery receipt identity changed.");
      const artifactId = `ARTIFACT-BASELINE-${id}`;
      let artifact = await loadArtifact(artifactId);
      if (!artifact) {
        intent ??= { check_id: `CHECK-BASELINE-${id}`, type: "baseline_recovery", identity, task_id: taskId, project_id: projectId,
          execution_id: executionId, commit_sha: original.commit_sha, source_revision: original.source_revision,
          environment: original.environment, pre_commit: false, status: "running", started_at: new Date().toISOString() };
        await stateFileService.atomicWrite({ path, content: `${JSON.stringify(intent)}\n`, replace: true });
        log("started", request);
        const environment = await restoreEnvironment(projectRoot, original.environment, Object.keys(original.file_checksums));
        archive = await materialize({ projectRoot, commitSha: original.commit_sha, ticketPaths: Object.keys(original.file_checksums), environment });
        if (archive.environment?.sha256 !== request.environment_sha256) throw fail("Baseline recovery environment changed.");
        await archive.assertEnvironment(); await archive.assertTicketSource();
        const results = await runCommands({ commands: request.commands, context, projectRoot, sourceRoot: archive.path, archive, environment,
          runCommand: async (input) => { await checkActive(); return runCommand({ ...input, signal, projectRoot }); }, safeOutput, projectLogger, taskId });
        await checkActive(); await archive.assertEnvironment(); await archive.assertTicketSource();
        const commands = [...original.commands.slice(0, request.from_command), ...results];
        artifact = { ...original, artifact_id: artifactId, commands, status: "failed", context_revision: context.version,
          stdout_redacted: commands.map(command => command.stdout_redacted).join("\n"),
          stderr_redacted: commands.map(command => command.stderr_redacted).join("\n"),
          started_at: intent.started_at, completed_at: new Date().toISOString(),
          baseline_recovery: { ...identity.request, execution_id: executionId, runner_revision: runner, evidence_ref: path } };
        const passed = commands.length === original.planned_commands.length && commands.every(verificationCommandAccepted)
          && coversVerificationPolicy(artifact, artifact.changed_paths, context.verification_plan ?? []);
        artifact.status = passed ? "passed" : "failed";
        artifact.exit_code = passed ? 0 : commands.find(command => !verificationCommandAccepted(command))?.exit_code ?? null;
        await checkActive(); await assertContext(context); await assertIdentity(context);
        await saveArtifact(artifact);
      }
      if (artifact.baseline_recovery?.execution_id !== executionId || artifact.baseline_recovery?.runner_revision !== runner
        || artifact.baseline_recovery?.artifact_id !== original.artifact_id) throw fail("Baseline recovery artifact identity changed.");
      if (["task_id", "project_id", "commit_sha", "base_sha", "source_revision", "manifest_sha", "policy_version"].some(key => artifact[key] !== original[key])
        || ["environment", "file_checksums", "planned_commands", "changed_paths", "verification_source"].some(key => digest(artifact[key] ?? null) !== digest(original[key] ?? null))
        || artifact.status === "passed" && (artifact.exit_code !== 0 || !coversVerificationPolicy(artifact, artifact.changed_paths, context.verification_plan ?? [])))
        throw fail("Persisted baseline artifact no longer proves the recorded source and verification plan.");
      await checkActive(); await assertContext(context); await assertIdentity(context);
      const failed = artifact.commands.find(command => !verificationCommandAccepted(command));
      const error = artifact.status === "passed" ? null : { code: failed?.disposition === "unattributed_failure" ? "VERIFY_BASELINE_UNAVAILABLE" : "VERIFY_COMMAND_FAILED",
        message: "Recorded-environment baseline recovery completed; inspect the source-bound failure receipt." };
      const job = { job_id: `VERIFY-BASELINE-${id}`, task_id: taskId, source_revision: original.source_revision, commit_sha: original.commit_sha,
        policy_version: policyVersion, runner_revision: runner, attempt: 1, status: artifact.status, artifact_id: artifactId,
        started_at: artifact.started_at, finished_at: artifact.completed_at, ...(error ? { error } : {}),
        result: { status: artifact.status, ready_for_review: artifact.status === "passed", commit_id: original.commit_sha, artifact_id: artifactId } };
      const receipt = { ...intent, status: artifact.status, exit_code: artifact.exit_code, artifact_id: artifactId, job_id: job.job_id, error,
        completed_at: artifact.completed_at, evidence_ref: path };
      await stateFileService.atomicWrite({ path, content: `${JSON.stringify(receipt)}\n`, replace: true });
      await checkActive(); await assertContext(context);
      if (artifact.status === "passed" && context.state !== "verified") await updateContext(context.version, { state: "verified", verification_artifact_id: artifactId });
      await saveJob(job);
      log(artifact.status, request);
      return { status: receipt.status, artifact_id: artifactId, job_id: job.job_id, evidence_ref: path, error };
    } finally { try { await archive?.cleanup(); } finally { await lock.release(); } }
  }
  /** Prevents evidence publication after another execution changes the retained source. */
  async function assertContext(expected) {
    const current = await loadContext();
    if (["version", "source_revision", "review_commit_sha", "manifest_sha", "base_sha", "project_id", "task_id"].some(key => current?.[key] !== expected[key]))
      throw fail("Ticket context changed during baseline recovery.");
  }
  /** Emits one start and terminal event; bounded diagnostics stay in ordinary receipts. */
  function log(status, request) {
    projectLogger({ event_name: `ticket.baseline_recovery_${status}`, level: status === "failed" ? "warn" : "info",
      status: status === "passed" ? "success" : status, task_id: taskId,
      message: status === "started" ? "Node is executing recorded-environment baseline recovery; passing checks are retained."
        : "Node baseline recovery finished; returning verification evidence to Sprint Leader.",
      payload: { artifact_id: request.artifact_id, commit_sha: request.commit_sha, base_sha: request.base_sha,
        environment_sha256: request.environment_sha256, command_count: request.commands.length } });
  }
}
