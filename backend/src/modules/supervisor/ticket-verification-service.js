// Verifies the exact ticket commit and persists safe evidence across Control API restarts.
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";
import { createTicketRootGit } from "./ticket-root-git.js";
import { materializeTicketArchive } from "./ticket-archive-materialization.js";

const ROOT = ".forge/runtime/ticket-verification";
const POLICY_VERSION = "ticket-verification-v1";
const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });
const sha = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

// Runs policy-selected checks in a ticket worktree and writes immutable artifact files.
export function createTicketVerificationService({ taskId, projectId, projectRoot, worktreeRoot, worktreeFileService, stateFileService, gitService, ledger, executionContexts, rootOnly = false, projectLogger = () => {}, runCommand = executeCommand } = {}) {
  if (!/^[A-Za-z0-9._:-]+$/.test(taskId ?? "") || !projectId || !worktreeRoot || !worktreeFileService?.readFile || !stateFileService?.atomicWrite || !gitService?.getHead || !ledger?.snapshot || !executionContexts?.load) throw fail("CONFIGURATION_ERROR", "Ticket verification requires worktree, ledger, Git, and context persistence.");
  const jobs = new Map();
  const rootGit = rootOnly ? createTicketRootGit({ projectRoot }) : null;
  const jobPath = (id) => `${ROOT}/${taskId}/jobs/${id}.json`;
  const artifactPath = (id) => `${ROOT}/${taskId}/artifacts/${id}.json`;
  return Object.freeze({ startTests, getTestResult, loadArtifact, assertPassedArtifact, assertCleanWorktree });

  // Starts a durable verification job only after the ticket commit is recorded.
  async function startTests() {
    const context = await executionContexts.load(taskId);
    if (context?.state === "verified" && context.verification_artifact_id) {
      const artifact = await assertPassedArtifact();
      const existing = { job_id: `REUSE-${artifact.artifact_id}`, task_id: taskId, status: "passed", artifact_id: artifact.artifact_id, result: { status: "passed", ready_for_review: true, commit_id: artifact.commit_sha, artifact_id: artifact.artifact_id }, started_at: artifact.started_at, finished_at: artifact.completed_at };
      await saveJob(existing);
      return existing;
    }
    if (context?.state !== "committed" || !context.review_commit_sha) throw fail("TICKET_COMMIT_REQUIRED", "Commit ticket changes before running final verification.");
    await assertIdentity(context);
    const previous = await sameRevisionJob(context);
    if (previous?.status === "failed") throw fail("VERIFY_RETRY_UNCHANGED", "Verification already failed for this commit and source revision. Fix the failure and commit a new revision before run_test.");
    if (previous?.status === "running") {
      if (jobs.has(previous.job_id)) return previous;
      await getTestResult({ jobId: previous.job_id });
      throw fail("VERIFY_RETRY_UNCHANGED", "Verification was interrupted for this commit. Commit a new source revision before run_test.");
    }
    const id = `VERIFY-${randomUUID()}`;
    const job = { job_id: id, task_id: taskId, status: "running", source_revision: context.source_revision, commit_sha: context.review_commit_sha, started_at: new Date().toISOString() };
    await saveJob(job);
    const run = verify(context, job).catch(async (error) => {
      const failed = { ...job, status: "failed", error: { code: error.code ?? "VERIFY_FAILED", message: safeOutput(error.message) }, finished_at: new Date().toISOString() };
      await saveJob(failed);
      projectLogger({ event_name: "ticket.verification_failed", level: "error", status: "failed", message: "Ticket verification failed.", task_id: taskId, source: "ticket-verification-service", error_code: failed.error.code, payload: { job_id: id, commit_sha: job.commit_sha } });
    });
    jobs.set(id, run);
    void run.finally(() => jobs.delete(id)).catch((error) => projectLogger({ event_name: "ticket.verification_job_failed", level: "error", status: "failed", message: "Verification job persistence failed.", task_id: taskId, source: "ticket-verification-service", error_code: error.code ?? "VERIFY_JOB_FAILED", payload: { job_id: id } }));
    return { job_id: id, status: "running", started_at: job.started_at };
  }

  // Returns a persisted job receipt so polling survives a process restart.
  async function getTestResult({ jobId, taskId: requestedTaskId } = {}) {
    if (requestedTaskId && requestedTaskId !== taskId) throw fail("TEST_JOB_FORBIDDEN", "Verification job belongs to another ticket.");
    if (!/^VERIFY-[A-Za-z0-9-]+$|^REUSE-ARTIFACT-[A-Za-z0-9-]+$/.test(jobId ?? "")) throw fail("TEST_JOB_NOT_FOUND", "Verification job ID is invalid.");
    const job = await loadJson(jobPath(jobId));
    if (!job) throw fail("TEST_JOB_NOT_FOUND", "Verification job was not found.");
    if (job.status === "running" && !jobs.has(jobId)) { const interrupted = { ...job, status: "failed", error: { code: "VERIFY_INTERRUPTED", message: "Verification was interrupted; run it again." }, finished_at: new Date().toISOString() }; await saveJob(interrupted); return interrupted; }
    return job;
  }

  // Loads one immutable artifact by ID for report and review gates.
  async function loadArtifact(artifactId) { if (!/^ARTIFACT-[A-Za-z0-9-]+$/.test(artifactId ?? "")) throw fail("VERIFY_ARTIFACT_ID_INVALID", "Verification artifact ID is invalid."); return loadJson(artifactPath(artifactId)); }

  // Rejects stale, failed, or mismatched evidence before a completion report.
  async function assertPassedArtifact() {
    const context = await executionContexts.load(taskId);
    const artifact = context?.verification_artifact_id ? await loadArtifact(context.verification_artifact_id) : null;
    if (!artifact || artifact.status !== "passed" || artifact.commit_sha !== context.review_commit_sha || artifact.source_revision !== context.source_revision || artifact.manifest_sha !== context.manifest_sha || artifact.base_sha !== context.base_sha) throw fail("VERIFY_ARTIFACT_MISMATCH", "A passed verification artifact for the current ticket commit is required.");
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
  async function verify(context, job) {
    const checksums = await assertIdentity(context);
    const archive = rootOnly ? await materializeTicketArchive({ projectRoot, commitSha: context.review_commit_sha }) : null;
    try { return await verifyInDirectory(context, job, checksums, archive); }
    finally { await archive?.cleanup(); }
  }

  // Runs the fixed verification plan against the exact committed tree.
  async function verifyInDirectory(context, job, checksums, archive) {
    const sourceRoot = archive?.path ?? worktreeRoot;
    if (archive) await assertArchiveSource(sourceRoot, checksums);
    const commands = await verificationPlan(context.manifest_paths, sourceRoot);
    if (!commands.length) throw fail("VERIFY_PLAN_EMPTY", "Ticket has no required verification checks.");
    const results = [];
    for (const command of commands) {
      const started = Date.now();
      const output = await runCommand({ ...command, cwd: sourceRoot, timeoutMs: 300_000 });
      results.push({ kind: command.kind, argv: command.argv, exit_code: output.exit_code, duration_ms: Date.now() - started, stdout_redacted: safeOutput(output.stdout), stderr_redacted: safeOutput(output.stderr) });
      if (output.exit_code !== 0) break;
    }
    const finalChecksums = await assertIdentity(context);
    if (archive) await assertArchiveSource(sourceRoot, checksums);
    if (JSON.stringify(finalChecksums) !== JSON.stringify(checksums)) throw fail("VERIFY_SOURCE_STALE", "Ticket source changed while verification ran.");
    const latest = await executionContexts.load(taskId);
    if (latest.version !== context.version || latest.source_revision !== context.source_revision || latest.review_commit_sha !== context.review_commit_sha) throw fail("VERIFY_CONTEXT_STALE", "Ticket context changed while verification ran.");
    const artifactId = `ARTIFACT-${randomUUID()}`;
    const passed = results.length === commands.length && results.every((entry) => entry.exit_code === 0);
    const treeSha = rootOnly ? (await rootGit.run(["rev-parse", `${context.review_commit_sha}^{tree}`])).trim() : null;
    const artifact = { artifact_id: artifactId, task_id: taskId, project_id: projectId, context_revision: context.version, source_revision: context.source_revision, base_sha: context.base_sha, commit_sha: context.review_commit_sha, tree_sha: treeSha, cwd: sourceRoot, materialization_method: archive?.method ?? "ticket-worktree", manifest_sha: context.manifest_sha, file_checksums: checksums, policy_version: POLICY_VERSION, commands: results, exit_code: results.at(-1)?.exit_code ?? null, stdout_redacted: results.map((entry) => entry.stdout_redacted).join("\n"), stderr_redacted: results.map((entry) => entry.stderr_redacted).join("\n"), status: passed ? "passed" : "failed", started_at: job.started_at, completed_at: new Date().toISOString() };
    await stateFileService.atomicWrite({ path: artifactPath(artifactId), content: `${JSON.stringify(artifact)}\n`, replace: false });
    if (passed) await executionContexts.update(taskId, context.version, { state: "verified", verification_artifact_id: artifactId });
    await saveJob({ ...job, status: passed ? "passed" : "failed", artifact_id: artifactId, result: { status: passed ? "passed" : "failed", ready_for_review: passed, commit_id: context.review_commit_sha, artifact_id: artifactId, breakdown: results.map(({ kind, exit_code, duration_ms }) => ({ kind, exit_code, duration_ms })) }, finished_at: artifact.completed_at });
    projectLogger({ event_name: "ticket.verification_completed", level: passed ? "info" : "error", status: passed ? "success" : "failed", message: "Ticket commit verification completed.", task_id: taskId, source: "ticket-verification-service", payload: { artifact_id: artifactId, commit_sha: context.review_commit_sha, checks: results.length, policy_version: POLICY_VERSION } });
  }

  // Confirms verification commands did not change any committed source in the archive.
  async function assertArchiveSource(sourceRoot, checksums) {
    for (const [path, expected] of Object.entries(checksums)) {
      let content = null;
      try { content = await readFile(join(sourceRoot, path), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (sha(content) !== expected) throw fail("VERIFY_SOURCE_MISMATCH", `Archive source differs from ticket commit: ${path}.`);
    }
  }

  // Persists a compact job state without exposing command output to the UI stream.
  async function saveJob(job) { await stateFileService.atomicWrite({ path: jobPath(job.job_id), content: `${JSON.stringify(job)}\n`, replace: true }); }

  // Reads a durable receipt and distinguishes absence from corrupt persistence.
  async function loadJson(path) {
    try { return JSON.parse(await stateFileService.readFile({ path })); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  // Prevents repeated full verification of an unchanged failed ticket commit after resume or restart.
  async function sameRevisionJob(context) {
    let names;
    try { names = await readdir(join(projectRoot, ROOT, taskId, "jobs")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    for (const name of names.filter((item) => /^VERIFY-[A-Za-z0-9-]+\.json$/.test(item)).sort().reverse()) {
      const job = await loadJson(`${ROOT}/${taskId}/jobs/${name}`);
      if (job?.commit_sha === context.review_commit_sha && job.source_revision === context.source_revision && ["failed", "running"].includes(job.status)) return job;
    }
    return null;
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

// Selects a fixed Node-owned verification plan from the ledger manifest.
async function verificationPlan(paths, root) {
  const checks = [];
  if (paths.some((path) => path.startsWith("backend/"))) {
    checks.push({ kind: "typecheck", argv: [process.execPath, "node_modules/typescript/bin/tsc", "--project", "jsconfig.json"] });
    const lintPaths = paths.filter((path) => /^backend\/.*\.[cm]?js$/.test(path));
    if (lintPaths.length) checks.push({ kind: "lint", argv: [process.execPath, "node_modules/eslint/bin/eslint.js", "--rulesdir", "eslint-rules", "--no-ignore", "--max-warnings=0", ...lintPaths] });
    const tests = paths.filter((path) => /^backend\/tests\/.*\.test\.js$/.test(path));
    if (tests.length) checks.push({ kind: "test", argv: [process.execPath, "--test", ...tests] });
    else {
      const unitTests = (await readdir(join(root, "backend/tests/unit"), { recursive: true })).filter((path) => path.endsWith(".test.js")).sort().map((path) => `backend/tests/unit/${path}`);
      if (!unitTests.length) throw fail("VERIFY_PLAN_EMPTY", "Backend verification has no unit tests to run.");
      checks.push({ kind: "test", argv: [process.execPath, "--test", ...unitTests] });
    }
  }
  if (paths.some((path) => path.startsWith("ui/nextjs/"))) {
    const entries = await readdir(join(root, "ui/nextjs/tests"), { withFileTypes: true });
    const tests = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".test.js")).map((entry) => `ui/nextjs/tests/${entry.name}`);
    if (tests.length) checks.push({ kind: "test", argv: [process.execPath, "--test", ...tests] });
    checks.push({ kind: "build", argv: [process.execPath, "ui/nextjs/node_modules/next/dist/bin/next", "build", "ui/nextjs", "--webpack"] });
  }
  if (!checks.length) checks.push({ kind: "typecheck", argv: [process.execPath, "node_modules/typescript/bin/tsc", "--project", "jsconfig.json"] });
  return checks;
}

// Executes one argument-vector command with bounded output and no shell.
function executeCommand({ argv, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PWD: cwd };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(0, 65_536); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(0, 65_536); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ exit_code: timedOut ? null : code, stdout, stderr }); });
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
