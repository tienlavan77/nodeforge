// Manages test execution jobs with async polling and timeout handling.
import { ConfigurationError } from "../shared/errors.js";

// Creates a service for running tests with async job tracking.
export function createTestService({ verificationOrchestrator, fileService, timeoutMs = 120000, jobTimeoutMs = 300000, projectRoot, publisher, internalBus, projectLogger = () => {} } = {}) {
  if (typeof verificationOrchestrator?.run !== "function") throw new ConfigurationError("TestService requires a Verification Orchestrator.");
  if (typeof projectRoot !== "string" || !projectRoot) throw new ConfigurationError("TestService requires a project root.");
  void fileService;
  const jobs = new Map();
  let jobSequence = 0;
  return Object.freeze({ runTests, runLint, runTypecheck, startTests, getTestResult });
  async function runTests({ commitId, levels = ["unit_test"], taskId, sessionId, command } = {}) {
    return run({ commitId, levels, taskId, sessionId, command });
  }
  async function runLint({ commitId, taskId, sessionId } = {}) { return run({ commitId, levels: ["lint"], taskId, sessionId }); }
  async function runTypecheck({ commitId, taskId, sessionId } = {}) { return run({ commitId, levels: ["typecheck"], taskId, sessionId }); }

  // Async job store: run_test starts a job and returns immediately so long suites
  // do not collide with the SDK per-turn timeout; check_test polls getTestResult.
  function startTests({ commitId, levels = ["unit_test"], taskId, sessionId, command } = {}) {
    pruneJobs();
    jobSequence += 1;
    const jobId = `TEST-JOB-${jobSequence}`;
    const job = { job_id: jobId, task_id: taskId ?? null, status: "running", started_at: new Date().toISOString() };
    jobs.set(jobId, job);
    run({ commitId, levels, taskId, sessionId, command, deadlineMs: jobTimeoutMs }).then((result) => {
      job.status = result?.status === "failed" ? "failed" : "passed";
      job.result = result;
      job.finished_at = new Date().toISOString();
      logJobCompleted(job, { taskId, sessionId });
    }, (error) => {
      job.status = "failed";
      job.error = { code: error.code ?? "TEST_EXECUTION_FAILED", message: error.message };
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
  function pruneJobs() {
    if (jobs.size < 50) return;
    for (const [id, entry] of jobs) { if (entry.status !== "running") jobs.delete(id); if (jobs.size < 50) break; }
  }
  async function run({ commitId = `WORKTREE-${Date.now()}`, levels, taskId, sessionId, command, deadlineMs = timeoutMs }) {
    const plan = { commit_id: commitId, levels: ["focused"], checks: levels.map((type) => ({ type: type === "unit_test" ? "test" : type, command: command ?? commandFor(type, taskId), timeout_ms: deadlineMs })) };
    publish("verification.test_started", { commit_id: commitId, task_id: taskId, session_id: sessionId, levels });
    try {
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { const error = new ConfigurationError(`Test execution timed out after ${deadlineMs}ms.`); error.code = "TEST_TIMEOUT"; reject(error); }, deadlineMs); });
      try {
        const result = await Promise.race([verificationOrchestrator.run(plan, { taskId, sessionId, timeoutMs: deadlineMs }), deadline]);
        publish("verification.result", result);
        return result;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (error.code === "TEST_TIMEOUT") publish("process.timed_out", { task_id: taskId, session_id: sessionId, timeout_ms: deadlineMs });
      throw error;
    }
  }
  function commandFor(type, taskId) {
    if (type === "unit_test" && typeof taskId === "string" && /^(tests|test)\//.test(taskId)) return `node --test ${taskId}`;
    return { lint: "npm run lint", typecheck: "npm run typecheck", unit_test: "npm test" }[type] ?? "npm test";
  }
  function publish(type, payload) { const event = { type, project_root: projectRoot, payload }; publisher?.publish?.({ event_id: `EVT-${Date.now()}`, type, project_id: payload.project_id ?? "PROJECT-NODEFORGE", timestamp: new Date().toISOString(), payload, metadata: { source: "test-service", task_id: payload.task_id, session_id: payload.session_id } }); internalBus?.emit?.(type, event); }
  function logJobCompleted(job, { taskId, sessionId } = {}) {
    if (!taskId) return;
    const duration_ms = Date.parse(job.finished_at) - Date.parse(job.started_at);
    try {
      projectLogger({
        event_name: "test.job_completed",
        level: job.status === "passed" ? "info" : "error",
        status: job.status === "passed" ? "success" : "failed",
        message: `Test job ${job.job_id} ${job.status} after ${duration_ms}ms.`,
        task_id: taskId,
        source: "test-service",
        ...(job.error?.code ? { error_code: job.error.code } : {}),
        payload: { job_id: job.job_id, task_id: job.task_id, job_status: job.status, duration_ms, ...(job.error ? { error: job.error } : {}), ...(sessionId ? { session_id: sessionId } : {}) }
      });
    } catch {}
  }
}
