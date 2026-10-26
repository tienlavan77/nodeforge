// Verifies the exact ticket commit and persists safe evidence across Control API restarts.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";
import { createTicketRootGit } from "./ticket-root-git.js";
import { materializeTicketVerification } from "./ticket-verification-materialization.js";
import { captureVerificationEnvironment, loadVerificationEnvironment } from "./ticket-verification-environment.js";
import { buildTicketVerificationPlan, requiresSchemaVerification } from "./ticket-verification-plan.js";
import { createTicketVerificationRecovery } from "./ticket-verification-recovery.js";
import { latestTicketVerificationAttempt } from "./ticket-verification-attempts.js";
import { ticketVerificationRunnerRevision } from "./ticket-verification-runner-revision.js";
import { createTicketFocusedCheck } from "./ticket-focused-check.js";
import { coversVerificationPolicy } from "./ticket-verification-policy.js";
import { runTicketVerificationCommands, verificationCommandAccepted } from "./ticket-verification-regression.js";
import { createTicketVerificationDiagnostic } from "./ticket-verification-diagnostic.js";
import { createReviewVerificationService } from "./review-verification-service.js";
import { createTicketReportChecks } from "./ticket-report-checks.js";
import { filesystemVerificationCommand } from "./filesystem-verification-command.js";

const ROOT = statePath("ticket-verification");
const POLICY_VERSION = "ticket-verification-v8";
const MAX_SAME_REVISION_ATTEMPTS = 2;
const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });
const sha = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

// Runs policy-selected checks in a ticket worktree and writes immutable artifact files.
export function createTicketVerificationService({ taskId, projectId, projectRoot, worktreeRoot, worktreeFileService, stateFileService, gitService, ledger, executionContexts, rootOnly = false, resumeReviewSource, projectLogger = () => {}, runCommand = executeCommand } = {}) {
  if (!/^[A-Za-z0-9._:-]+$/.test(taskId ?? "") || !projectId || !worktreeRoot || !worktreeFileService?.readFile || !stateFileService?.atomicWrite || !gitService?.getHead || !ledger?.snapshot || !executionContexts?.load) throw fail("CONFIGURATION_ERROR", "Ticket verification requires worktree, ledger, Git, and context persistence.");
  const jobs = new Map();
  const rootGit = rootOnly ? createTicketRootGit({ projectRoot }) : null;
  const jobPath = (id) => `${ROOT}/${taskId}/jobs/${id}.json`;
  const artifactPath = (id) => `${ROOT}/${taskId}/artifacts/${id}.json`;
  const checkPath = (id) => `${ROOT}/${taskId}/checks/${id}.json`;
  const ensurePassedArtifact = createTicketVerificationRecovery({ taskId, executionContexts, assertIdentity, assertPassedArtifact, startTests, getTestResult, getFailureDiagnostic: () => getFailureDiagnostic(), maxAttempts: MAX_SAME_REVISION_ATTEMPTS });
  const runCheck = createTicketFocusedCheck({ taskId, projectRoot, worktreeFileService, ledger, executionContexts, stateFileService, assertIdentity, assertArchiveSource, runCommand, safeOutput, loadArtifact });
  const runReviewVerification = createReviewVerificationService({ taskId, projectId, projectRoot, stateFileService, runCommand, safeOutput, projectLogger });
  const reportChecks = createTicketReportChecks({ taskId, loadContext: () => executionContexts.load(taskId),
    updateContext: (version, changes) => executionContexts.update(taskId, version, changes), loadArtifact,
    loadCheck: (id) => loadJson(checkPath(id)), saveArtifact: saveReportArtifact, assertIdentity });
  const getFailureDiagnostic = createTicketVerificationDiagnostic({ loadContext: () => executionContexts.load(taskId), loadArtifact,
    latestJob: async (context) => latestTicketVerificationAttempt({ projectRoot, taskId, context, policyVersion: POLICY_VERSION, matchRunnerRevision: false, loadJob: (id) => loadJson(jobPath(id)) }) });
  return Object.freeze({ runCheck, runReviewVerification, startTests, getTestResult, loadArtifact, assertPassedArtifact, ensurePassedArtifact, prepareReportEvidence: reportChecks.prepareReportEvidence, assertCleanWorktree, getFailureDiagnostic });

  // Starts a durable verification job only after the ticket commit is recorded.
  async function startTests() {
    const context = await executionContexts.load(taskId);
    if (context?.state === "verified" && context.verification_artifact_id) {
      let artifact;
      try { artifact = await assertPassedArtifact(); }
      catch (error) { if (error.code !== "VERIFY_ARTIFACT_MISMATCH") throw error; await executionContexts.update(taskId, context.version, { state: "committed", verification_artifact_id: null }); return startTests(); }
      const existing = { job_id: `REUSE-${artifact.artifact_id}`, task_id: taskId, status: "passed", artifact_id: artifact.artifact_id, result: { status: "passed", ready_for_review: true, commit_id: artifact.commit_sha, artifact_id: artifact.artifact_id }, started_at: artifact.started_at, finished_at: artifact.completed_at };
      await saveJob(existing);
      return existing;
    }
    if (context?.state !== "committed" || !context.review_commit_sha) throw fail("TICKET_COMMIT_REQUIRED", "Commit ticket changes before running final verification.");
    await assertIdentity(context);
    const environment = rootOnly ? await captureVerificationEnvironment({ projectRoot, ticketPaths: context.manifest_paths }) : null;
    const runner = await ticketVerificationRunnerRevision(context.verification_plan);
    const runnerRevision = environment ? JSON.stringify([runner, environment.sha256]) : runner;
    const previous = await latestTicketVerificationAttempt({ projectRoot, taskId, context, policyVersion: POLICY_VERSION, runnerRevision, loadJob: (id) => loadJson(jobPath(id)) });
    if (previous?.status === "failed" && previous.attempt >= MAX_SAME_REVISION_ATTEMPTS) throw fail("VERIFY_RETRY_UNCHANGED", `Verification failed ${MAX_SAME_REVISION_ATTEMPTS} times for this commit, source revision, and runner revision. Last failure: ${previous.error?.code ?? "VERIFY_FAILED"}. Repair the reported cause; unchanged retries are blocked, but project environment or browser runner repairs do not require ticket code changes.`);
    if (previous?.status === "running") {
      if (jobs.has(previous.job_id)) return previous;
      await getTestResult({ jobId: previous.job_id });
      if (previous.attempt >= MAX_SAME_REVISION_ATTEMPTS) throw fail("VERIFY_RETRY_UNCHANGED", `Verification was interrupted ${MAX_SAME_REVISION_ATTEMPTS} times for this commit and source revision.`);
    }
    const id = `VERIFY-${randomUUID()}`;
    const job = { job_id: id, task_id: taskId, attempt: (previous?.attempt ?? 0) + 1, status: "running", source_revision: context.source_revision, commit_sha: context.review_commit_sha, policy_version: POLICY_VERSION, runner_revision: runnerRevision, started_at: new Date().toISOString() };
    await saveJob(job);
    const run = verify(context, job, environment).catch(async (error) => {
      const failed = { ...job, status: "failed", error: { code: error.code ?? "VERIFY_FAILED", message: safeOutput(error.message) }, finished_at: new Date().toISOString() };
      await saveJob(failed);
      projectLogger({ event_name: "ticket.verification_failed", level: "error", status: "failed", message: "Ticket verification failed.", task_id: taskId, source: "ticket-verification-service", error_code: failed.error.code, payload: { job_id: id, commit_sha: job.commit_sha } });
    });
    jobs.set(id, run);
    void run.finally(() => jobs.delete(id)).catch((error) => projectLogger({ event_name: "ticket.verification_job_failed", level: "error", status: "failed", message: "Verification job persistence failed.", task_id: taskId, source: "ticket-verification-service", error_code: error.code ?? "VERIFY_JOB_FAILED", payload: { job_id: id } }));
    return { job_id: id, attempt: job.attempt, status: "running", started_at: job.started_at };
  }

  // Returns a persisted job or focused-check receipt so polling survives a process restart.
  async function getTestResult({ jobId, taskId: requestedTaskId } = {}) {
    if (requestedTaskId && requestedTaskId !== taskId) throw fail("TEST_JOB_FORBIDDEN", "Verification job belongs to another ticket.");
    if (/^CHECK-[A-Za-z0-9-]+$/.test(jobId ?? "")) {
      const check = await loadJson(checkPath(jobId));
      if (!check) throw fail("TEST_JOB_NOT_FOUND", "Focused check receipt was not found.");
      if (check.task_id && check.task_id !== taskId) throw fail("TEST_JOB_FORBIDDEN", "Focused check receipt belongs to another ticket.");
      return { ...check, job_id: check.check_id, stdout_redacted: safeOutput(check.stdout), stderr_redacted: safeOutput(check.stderr) };
    }
    if (!/^VERIFY-[A-Za-z0-9-]+$|^REUSE-ARTIFACT-[A-Za-z0-9-]+$/.test(jobId ?? "")) throw fail("TEST_JOB_NOT_FOUND", "Verification job ID is invalid.");
    let job = await loadJson(jobPath(jobId));
    if (!job) throw fail("TEST_JOB_NOT_FOUND", "Verification job was not found.");
    if (job.task_id && job.task_id !== taskId) throw fail("TEST_JOB_FORBIDDEN", "Verification job belongs to another ticket.");
    // Completion may persist its terminal receipt while this poll is reading the previous running receipt.
    if (job.status === "running" && !jobs.has(jobId)) job = await loadJson(jobPath(jobId)) ?? job;
    if (job.status === "running" && !jobs.has(jobId)) { const interrupted = { ...job, status: "failed", error: { code: "VERIFY_INTERRUPTED", message: "Verification was interrupted; run it again." }, finished_at: new Date().toISOString() }; await saveJob(interrupted); return interrupted; }
    if (job.artifact_id) {
      const artifact = await loadJson(artifactPath(job.artifact_id));
      if (artifact) return { ...job, stdout_redacted: safeOutput(artifact.stdout_redacted), stderr_redacted: safeOutput(artifact.stderr_redacted), commands: (artifact.commands ?? []).map((entry) => ({ kind: entry.kind, exit_code: entry.exit_code, stdout_redacted: safeOutput(entry.stdout_redacted), stderr_redacted: safeOutput(entry.stderr_redacted) })) };
    }
    return job;
  }

  // Loads one immutable artifact by ID for report and review gates.
  async function loadArtifact(artifactId) { if (!/^ARTIFACT-[A-Za-z0-9-]+$/.test(artifactId ?? "")) throw fail("VERIFY_ARTIFACT_ID_INVALID", "Verification artifact ID is invalid."); return loadJson(artifactPath(artifactId)); }

  // Rejects stale, failed, pre-commit, or mismatched evidence before a completion report.
  async function assertPassedArtifact() {
    if (rootOnly && resumeReviewSource) await resumeReviewSource();
    const context = await executionContexts.load(taskId);
    const artifact = context?.verification_artifact_id ? await loadArtifact(context.verification_artifact_id) : null;
    if (!artifact || artifact.pre_commit === true || !artifact.commit_sha || artifact.status !== "passed" || artifact.commit_sha !== context.review_commit_sha || artifact.source_revision !== context.source_revision || artifact.manifest_sha !== context.manifest_sha || artifact.base_sha !== context.base_sha || JSON.stringify(artifact.verification_source ?? null) !== JSON.stringify(context.verification_source ?? null)) throw fail("VERIFY_ARTIFACT_MISMATCH", "A passed verification artifact for the current ticket commit is required.");
    if (rootOnly && (artifact.policy_version !== POLICY_VERSION || !artifact.environment)) throw fail("VERIFY_ARTIFACT_MISMATCH", "Refresh verification using the current project environment policy.");
    if (artifact.environment) await loadVerificationEnvironment(projectRoot, artifact.environment);
    let policyPaths = context.manifest_paths;
    if (artifact.policy_version === POLICY_VERSION) {
      const parent = await gitService.getCommitParent(context.verification_source?.ticket_commit_sha ?? context.review_commit_sha);
      const committedPaths = [...new Set(await gitService.getChangedFiles({ baseCommit: parent, headCommit: context.verification_source?.ticket_commit_sha ?? context.review_commit_sha }))].sort();
      if (!committedPaths.length || committedPaths.some((path) => !context.manifest_paths.includes(path)) || JSON.stringify(committedPaths) !== JSON.stringify(artifact.changed_paths)) throw fail("VERIFY_ARTIFACT_MISMATCH", "Verification artifact paths differ from the ticket commit.");
      policyPaths = committedPaths;
    }
    if (!coversVerificationPolicy(artifact, policyPaths, context.verification_plan ?? [])) throw fail("VERIFY_ARTIFACT_MISMATCH", "Verification artifact lacks current policy or complete command evidence.");
    await reportChecks.assertReportChecks(artifact);
    if (rootOnly && artifact.tree_sha !== (await rootGit.run(["rev-parse", `${context.review_commit_sha}^{tree}`])).trim()) throw fail("VERIFY_ARTIFACT_MISMATCH", "Verification artifact tree differs from the ticket commit.");
    await assertIdentity(context);
    return artifact;
  }
  // Rechecks the committed worktree during review while allowing only managed dependency links.
  async function assertCleanWorktree() {
    if (rootOnly) return;
    if (await hasSourceChanges(await gitService.status(), worktreeRoot, projectRoot)) throw fail("VERIFY_WORKTREE_DIRTY", "Ticket worktree has uncommitted changes during verification.");
  }

  // Checks ledger, worktree bytes, and Git HEAD against one persisted identity.
  async function assertIdentity(context) {
    const manifest = rootOnly ? await ledger.load(taskId) : await ledger.snapshot(taskId);
    const identity = executionContexts.manifestIdentity(manifest);
    if (identity.source_revision !== context.source_revision || identity.manifest_sha !== context.manifest_sha || JSON.stringify(identity.manifest_paths) !== JSON.stringify(context.manifest_paths)) throw fail("VERIFY_SOURCE_STALE", "Ticket ledger changed after commit.");
    if (rootOnly) await rootGit.assertAncestor(context.review_commit_sha);
    else if (await gitService.getHead() !== context.review_commit_sha) throw fail("VERIFY_COMMIT_STALE", "Ticket worktree HEAD changed after commit.");
    await assertCleanWorktree();
    const checksums = {};
    for (const path of context.manifest_paths) {
      let content = null;
      try { content = rootOnly ? await rootGit.fileAt(context.review_commit_sha, path) : await worktreeFileService.readFile({ path }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const checksum = content === null ? null : sha(content);
      if (checksum !== manifest.entries[path]?.latest_sha) throw fail("VERIFY_SOURCE_MISMATCH", `Ticket commit content differs from ledger: ${path}.`);
      checksums[path] = checksum;
    }
    return checksums;
  }

  // Runs every required check and persists its redacted output before recording success.
  async function verify(context, job, environment) {
    const checksums = await assertIdentity(context);
    const archive = rootOnly ? await materializeTicketVerification({ projectRoot, commitSha: context.review_commit_sha, ticketPaths: context.manifest_paths, environment }) : null;
    try { return await verifyInDirectory(context, job, checksums, archive, environment); }
    finally { await archive?.cleanup(); }
  }

  // Runs the fixed verification plan against the exact committed tree.
  async function verifyInDirectory(context, job, checksums, archive, environment) {
    const sourceRoot = archive?.path ?? worktreeRoot;
    if (archive) await assertArchiveSource(sourceRoot, checksums);
    const parent = await gitService.getCommitParent(context.verification_source?.ticket_commit_sha ?? context.review_commit_sha);
    const changedPaths = [...new Set(await gitService.getChangedFiles({ baseCommit: parent, headCommit: context.verification_source?.ticket_commit_sha ?? context.review_commit_sha }))].sort();
    if (!changedPaths.length || changedPaths.some((path) => !context.manifest_paths.includes(path))) throw fail("VERIFY_COMMIT_SCOPE", "Ticket commit has no changes or contains paths outside the verified manifest.");
    const fullBackend = context.approved_baseline?.verification_plan?.some((step) => /full backend suite|all backend tests/i.test(step)) === true;
    const commands = await buildTicketVerificationPlan(changedPaths, sourceRoot, { fullBackend, verificationPlan: context.verification_plan });
    if (!commands.length) throw fail("VERIFY_PLAN_EMPTY", "Ticket has no required verification checks.");
    if (requiresSchemaVerification(changedPaths) && !commands.some(({ kind }) => kind === "schema_validation")) throw fail("VERIFY_PLAN_INCOMPLETE", "Schema validation is missing from the immutable verification plan.");
    const results = await runTicketVerificationCommands({ commands, context, projectRoot, sourceRoot, archive, environment, runCommand, safeOutput, projectLogger, taskId });
    await archive?.assertEnvironment?.();
    const finalChecksums = await assertIdentity(context);
    if (archive) await assertArchiveSource(sourceRoot, checksums);
    if (JSON.stringify(finalChecksums) !== JSON.stringify(checksums)) throw fail("VERIFY_SOURCE_STALE", "Ticket source changed while verification ran.");
    const latest = await executionContexts.load(taskId);
    if (latest.version !== context.version || latest.source_revision !== context.source_revision || latest.review_commit_sha !== context.review_commit_sha) throw fail("VERIFY_CONTEXT_STALE", "Ticket context changed while verification ran.");
    const artifactId = `ARTIFACT-${randomUUID()}`;
    const passed = results.length === commands.length && results.every(verificationCommandAccepted) && (!requiresSchemaVerification(changedPaths) || results.some((entry) => entry.kind === "schema_validation" && verificationCommandAccepted(entry)));
    const treeSha = rootOnly ? (await rootGit.run(["rev-parse", `${context.review_commit_sha}^{tree}`])).trim() : null;
    const artifact = { artifact_id: artifactId, task_id: taskId, project_id: projectId, context_revision: context.version, source_revision: context.source_revision, base_sha: context.base_sha, commit_sha: context.review_commit_sha, verification_source: context.verification_source ?? null, tree_sha: treeSha, cwd: sourceRoot, materialization_method: archive?.method ?? "ticket-worktree", environment: archive?.environment ?? null, manifest_sha: context.manifest_sha, changed_paths: changedPaths, file_checksums: checksums, policy_version: POLICY_VERSION, verification_plan: context.verification_plan ?? [], planned_commands: commands, commands: results, exit_code: passed ? 0 : results.at(-1)?.exit_code ?? null, stdout_redacted: results.map((entry) => entry.stdout_redacted).join("\n"), stderr_redacted: results.map((entry) => entry.stderr_redacted).join("\n"), status: passed ? "passed" : "failed", started_at: job.started_at, completed_at: new Date().toISOString() };
    await stateFileService.atomicWrite({ path: artifactPath(artifactId), content: `${JSON.stringify(artifact)}\n`, replace: false });
    if (passed) await executionContexts.update(taskId, context.version, { state: "verified", verification_artifact_id: artifactId });
    const failedCommand = results.find((entry) => !verificationCommandAccepted(entry));
    const storageExhausted = /\bENOSPC\b|no space left on device/i.test(`${failedCommand?.stdout_redacted ?? ""}\n${failedCommand?.stderr_redacted ?? ""}`);
    const failureCode = storageExhausted ? "VERIFY_STORAGE_EXHAUSTED" : failedCommand?.disposition === "unattributed_failure" ? "VERIFY_BASELINE_UNAVAILABLE" : "VERIFY_COMMAND_FAILED";
    await saveJob({ ...job, status: passed ? "passed" : "failed", artifact_id: artifactId,
      ...(!passed ? { error: { code: failureCode, message: failedCommand ? `${failedCommand.kind} exited ${failedCommand.exit_code}${storageExhausted ? " because temporary storage is full" : ""}.${failureCode === "VERIFY_BASELINE_UNAVAILABLE" ? " Baseline evidence is insufficient to attribute this supplemental failure to the ticket." : ""}` : "Verification did not complete every required command." } } : {}),
      result: { status: passed ? "passed" : "failed", ready_for_review: passed, commit_id: context.review_commit_sha, artifact_id: artifactId, breakdown: results.map(({ kind, exit_code, duration_ms, scope, disposition }) => ({ kind, exit_code, duration_ms, scope, disposition })) }, finished_at: artifact.completed_at });
    projectLogger({ event_name: "ticket.verification_completed", level: passed ? "info" : "error", status: passed ? "success" : "failed", message: "Ticket commit verification completed.", task_id: taskId, source: "ticket-verification-service", payload: { artifact_id: artifactId, commit_sha: context.review_commit_sha, checks: results.length, policy_version: POLICY_VERSION } });
  }

  // Confirms verification commands did not change any committed source in the archive.
  async function assertArchiveSource(sourceRoot, checksums) {
    for (const [path, expected] of Object.entries(checksums)) {
      let content = null;
      try { content = await readFile(join(sourceRoot, path), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if ((content === null ? null : sha(content)) !== expected) throw fail("VERIFY_SOURCE_MISMATCH", `Archive source differs from ticket commit: ${path}.`);
    }
  }

  // Persists a compact job state without exposing command output to the UI stream.
  async function saveJob(job) { await stateFileService.atomicWrite({ path: jobPath(job.job_id), content: `${JSON.stringify(job)}\n`, replace: true }); }

  /** Publishes supplemental artifacts immutably and accepts an identical retry
   * after interruption without overwriting earlier verification evidence. */
  async function saveReportArtifact(artifact) {
    const content = `${JSON.stringify(artifact)}\n`;
    const existing = await loadArtifact(artifact.artifact_id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(artifact)) throw fail("VERIFY_ARTIFACT_MISMATCH", "Supplemental verification artifact identity conflicts with stored evidence.");
      return;
    }
    try { await stateFileService.atomicWrite({ path: artifactPath(artifact.artifact_id), content, replace: false }); }
    catch (error) {
      if (!["FILE_ALREADY_EXISTS", "EEXIST"].includes(error.code) || JSON.stringify(await loadArtifact(artifact.artifact_id)) !== JSON.stringify(artifact)) throw error;
    }
  }

  // Reads a durable receipt and distinguishes absence from corrupt persistence.
  async function loadJson(path) {
    try { return JSON.parse(await stateFileService.readFile({ path })); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

}

// Ignores only dependency links created by the ticket workspace; every other Git change invalidates evidence.
async function hasSourceChanges(status, worktreeRoot, projectRoot) {
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    if (!line.startsWith("?? ") || !projectRoot) return true;
    const path = line.slice(3);
    if (!["node_modules", "backend/node_modules", "ui/nextjs/node_modules"].includes(path)) return true;
    try { if (await readlink(join(worktreeRoot, path)) !== join(projectRoot, path)) return true; }
    catch (error) { if (error.code !== "EINVAL" && error.code !== "ENOENT") throw error; return true; }
  }
  return false;
}

// Executes one argument-vector command with bounded output and no shell.
function executeCommand({ argv, cwd, tempDir, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PWD: cwd, ...(tempDir ? { TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir } : {}) };
    delete env.NODE_TEST_CONTEXT;
    const launch = filesystemVerificationCommand(argv, cwd, env);
    const child = spawn(launch[0], launch.slice(1), { cwd, env, signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdoutHash.update(chunk); stdout = (stdout + chunk).slice(0, 65_536); });
    child.stderr.on("data", (chunk) => { stderrHash.update(chunk); stderr = (stderr + chunk).slice(0, 65_536); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ exit_code: timedOut ? null : code, stdout, stderr, output_sha256: sha(`${stdoutHash.digest("hex")}\0${stderrHash.digest("hex")}`) }); });
  });
}

// Redacts credentials and process URLs before evidence reaches disk or model prompts.
function safeOutput(raw) {
  let output = String(raw ?? "").slice(0, 65_536);
  output = output.replace(/https?:\/\/[^\s]+/gi, "[REDACTED_URL]");
  output = output.replace(/(api[_-]?key|secret|token|password|authorization)[=:]\s*[^\s]+/gi, "$1=[REDACTED]");
  output = output.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  for (const [name, value] of Object.entries(process.env)) if (/(?:api.?key|secret|token|password|credential)/i.test(name) && typeof value === "string" && value.length >= 8) output = output.split(value).join("[REDACTED]");
  return output;
}
