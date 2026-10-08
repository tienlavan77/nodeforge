// Manages test execution jobs with async polling and timeout handling.
// Normalizes UI errors to safe messages while preserving diagnostics.
// Aligned with UI retry semantics and redaction for NF-UI-CONV-003.
import { ConfigurationError } from "../shared/errors.js";
import { normalizeErrorContract } from "../shared/error-contract.js";

// Redacts secrets, URLs, stack traces and raw events from error messages while preserving request IDs.
function redactMessage(raw) {
  if (typeof raw !== "string") return raw ?? "Test execution failed.";
  let text = raw.trim();
  if (!text) return "Test execution failed.";
  // Remove stack traces
  text = text.split(/\n\s*at\s+/)[0].split(/stack trace/i)[0].trim();
  // Redact URLs
  text = text.replace(/https?:\/\/[^\s]+/gi, "[REDACTED_URL]");
  // Redact secrets/tokens
  text = text.replace(/(api[_-]?key|secret|token|password|authorization)[=:]\s*[^\s]+/gi, "$1=[REDACTED]");
  text = text.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  // Remove raw JSON payloads
  if (/^[[{]/.test(text) && text.length > 280) text = text.slice(0, 280);
  // Keep first line only for user-visible message
  text = text.split(/\r?\n/)[0].replace(/\s+/g, " ").slice(0, 280);
  return text || "Test execution failed.";
}

// Normalizes an error into a safe contract: {code, message, retryable, requestId}
// Exported for contract tests and UI retry semantics alignment — preserves string error compatibility.
export function normalizeError(error, { requestId } = {}) {
  const source = typeof error === "string" ? { message: error } : error ?? {};
  const code = source.code ?? "TEST_EXECUTION_FAILED";
  const retryable = source.retryable ?? !["INPUT_INVALID", "TEST_JOB_NOT_FOUND", "TEST_JOB_FORBIDDEN", "CONFIGURATION_ERROR", "VALIDATION_ERROR"].includes(code);
  return normalizeErrorContract({ error: { ...source, code, message: redactMessage(source.message), retryable }, requestId: requestId ?? source.requestId, fallbackMessage: "Test execution failed." });
}

// Creates a service for running tests with async job tracking.
export function createTestService({ verificationOrchestrator, fileService, timeoutMs = 120000, jobTimeoutMs = 300000, projectRoot, publisher, internalBus, projectLogger = () => {} } = {}) {
  if (typeof verificationOrchestrator?.run !== "function") throw new ConfigurationError("TestService requires a Verification Orchestrator.");
  // Archive verification has no live checkout, so project root remains optional metadata.
  if (projectRoot != null && (typeof projectRoot !== "string" || !projectRoot.trim())) throw new ConfigurationError("TestService project root must be a non-empty string when provided.");
  // File service is intentionally optional because immutable archive verification has no live project checkout.
  void fileService;
  const jobs = new Map();
  let jobSequence = 0;
  return Object.freeze({ runTests, runCheck, runLint, runTypecheck, runSchemaValidation, startTests, getTestResult, cancelTest });
  // Runs schema validation so immutable archive verification covers API contracts without a checkout.
  async function runSchemaValidation({ commitId, taskId, sessionId } = {}) { return run({ commitId, levels: ["schema_validation"], taskId, sessionId }); }
  async function runTests({ commitId, levels = ["unit_test"], taskId, sessionId, command } = {}) {
    const verificationLevels = Array.isArray(levels) && levels.length > 0 ? levels : ["unit_test"];
    return run({ commitId, levels: verificationLevels, taskId, sessionId, command });
  }
  // Runs one owner-requested project check to completion and returns its result in the same call.
  async function runCheck({ commitId, type = "test", taskId, sessionId, command, signal } = {}) {
    const level = type === "test" ? "unit_test" : type;
    return run({ commitId, levels: [level], taskId, sessionId, command, deadlineMs: jobTimeoutMs, signal });
  }
  async function runLint({ commitId, taskId, sessionId } = {}) { return run({ commitId, levels: ["lint"], taskId, sessionId }); }
  async function runTypecheck({ commitId, taskId, sessionId } = {}) { return run({ commitId, levels: ["typecheck"], taskId, sessionId }); }

  // Async job store: run_test starts a job and returns immediately so long suites
  // do not collide with the SDK per-turn timeout; check_test polls getTestResult.
  function startTests({ commitId, levels = ["unit_test"], taskId, sessionId, command } = {}) {
    const verificationLevels = Array.isArray(levels) && levels.length > 0 ? levels : ["unit_test"];
    pruneJobs();
    jobSequence += 1;
    const jobId = `TEST-JOB-${jobSequence}`;
    const job = { job_id: jobId, task_id: taskId ?? null, status: "running", started_at: new Date().toISOString(), controller: new AbortController() };
    jobs.set(jobId, job);
    run({ commitId, levels: verificationLevels, taskId, sessionId, command, deadlineMs: jobTimeoutMs, signal: job.controller.signal }).then((result) => {
      job.status = job.controller.signal.aborted ? "cancelled" : result?.status === "failed" ? "failed" : "passed";
      job.result = result;
      job.finished_at = new Date().toISOString();
      logJobCompleted(job, { taskId, sessionId });
    }, (error) => {
      job.status = job.controller.signal.aborted ? "cancelled" : "failed";
      job.error = normalizeError(error);
      job.finished_at = new Date().toISOString();
      logJobCompleted(job, { taskId, sessionId });
    });
    return { job_id: jobId, status: "running", started_at: job.started_at };
  }
  function getTestResult({ jobId, taskId } = {}) {
    if (typeof jobId !== "string" || !jobId.trim()) { const error = new ConfigurationError("getTestResult requires jobId."); error.code = "INPUT_INVALID"; throw error; }
    const job = jobs.get(jobId.trim());
    if (!job) { const error = new ConfigurationError(`Unknown test job: ${jobId}`); error.code = "TEST_JOB_NOT_FOUND"; throw error; }
    if (taskId && job.task_id && job.task_id !== taskId) { const error = new ConfigurationError("Test job belongs to a different task."); error.code = "TEST_JOB_FORBIDDEN"; throw error; }
    if (job.status === "running") return { job_id: job.job_id, status: "running", started_at: job.started_at, elapsed_ms: Date.now() - Date.parse(job.started_at) };
    return {
      job_id: job.job_id, status: job.status, started_at: job.started_at, finished_at: job.finished_at,
      duration_ms: Date.parse(job.finished_at) - Date.parse(job.started_at),
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {})
    };
  }
  // Aborts a running project check and lets its command runner reap the process group.
  function cancelTest({ jobId, taskId } = {}) {
    if (typeof jobId !== "string" || !jobId.trim()) { const error = new ConfigurationError("cancelTest requires jobId."); error.code = "INPUT_INVALID"; throw error; }
    const job = jobs.get(jobId.trim());
    if (!job) { const error = new ConfigurationError(`Unknown test job: ${jobId}`); error.code = "TEST_JOB_NOT_FOUND"; throw error; }
    if (taskId && job.task_id && job.task_id !== taskId) { const error = new ConfigurationError("Test job belongs to a different task."); error.code = "TEST_JOB_FORBIDDEN"; throw error; }
    if (job.status !== "running") return { job_id: job.job_id, status: job.status, cancelled: false };
    job.controller.abort(new ConfigurationError("Project check cancelled by System Engineer."));
    return { job_id: job.job_id, status: "cancellation_requested", cancelled: true };
  }
  function pruneJobs() {
    if (jobs.size < 50) return;
    for (const [id, entry] of jobs) { if (entry.status !== "running") jobs.delete(id); if (jobs.size < 50) break; }
  }
  async function run({ commitId = `WORKTREE-${Date.now()}`, levels, taskId, sessionId, command, deadlineMs = timeoutMs, signal }) {
    const plan = { commit_id: commitId, levels: ["focused"], checks: levels.map((type) => ({ type: type === "unit_test" ? "test" : type, command: command ?? commandFor(type, taskId), timeout_ms: deadlineMs })) };
    publish("verification.test_started", { commit_id: commitId, task_id: taskId, session_id: sessionId, levels });
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeoutError = Object.assign(new ConfigurationError(`Test execution timed out after ${deadlineMs}ms.`), { code: "TEST_TIMEOUT" });
    const timer = setTimeout(() => controller.abort(timeoutError), deadlineMs);
    try {
      const result = await verificationOrchestrator.run(plan, { taskId, sessionId, timeoutMs: deadlineMs, signal: controller.signal });
      if (controller.signal.aborted) throw controller.signal.reason;
      publish("verification.result", result);
      return result;
    } catch (error) {
      const failure = controller.signal.aborted ? controller.signal.reason : error;
      if (failure?.code === "TEST_TIMEOUT") publish("process.timed_out", { task_id: taskId, session_id: sessionId, timeout_ms: deadlineMs });
      throw failure;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", forwardAbort); }
  }
  function commandFor(type, taskId) {
    if (type === "unit_test" && typeof taskId === "string" && /^(tests|test)\//.test(taskId)) return `node --test ${taskId}`;
    return { lint: "pnpm lint", schema_validation: "pnpm validate:schemas", typecheck: "pnpm typecheck", unit_test: "pnpm test", build: "pnpm --dir ui/nextjs build" }[type] ?? "pnpm test";
  }
  function publish(type, payload) { const event = { type, project_root: projectRoot, payload }; publisher?.publish?.({ event_id: `EVT-${Date.now()}`, type, project_id: payload.project_id ?? "PROJECT-NODEFORGE", timestamp: new Date().toISOString(), payload, metadata: { source: "test-service", task_id: payload.task_id, session_id: payload.session_id } }); internalBus?.emit?.(type, event); }
  function logJobCompleted(job, { taskId, sessionId } = {}) {
    if (!taskId) return;
    const duration_ms = Date.parse(job.finished_at) - Date.parse(job.started_at);
    try {
      projectLogger({
        event_name: "test.job_completed",
        level: job.status === "passed" ? "info" : job.status === "cancelled" ? "warn" : "error",
        status: job.status === "passed" ? "success" : job.status === "cancelled" ? "warn" : "failed",
        message: `Test job ${job.job_id} ${job.status} after ${duration_ms}ms.`,
        task_id: taskId,
        source: "test-service",
        ...(job.error?.code ? { error_code: job.error.code } : {}),
        payload: { job_id: job.job_id, task_id: job.task_id, job_status: job.status, duration_ms, ...(job.error ? { error: job.error } : {}), ...(sessionId ? { session_id: sessionId } : {}) }
      });
    } catch (error) { console.warn("Test completion logging failed.", { error: error.message, task_id: taskId }); }
  }
}
