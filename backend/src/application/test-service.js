import { ConfigurationError } from "../shared/errors.js";

export function createTestService({ verificationOrchestrator, fileService, timeoutMs = 120000, projectRoot, publisher, internalBus } = {}) {
  if (typeof verificationOrchestrator?.run !== "function") throw new ConfigurationError("TestService requires a Verification Orchestrator.");
  if (typeof projectRoot !== "string" || !projectRoot) throw new ConfigurationError("TestService requires a project root.");
  void fileService;
  return Object.freeze({ runTests, runLint, runTypecheck });

  async function runTests({ commitId, levels = ["unit_test"], taskId, sessionId } = {}) {
    return run({ commitId, levels, taskId, sessionId });
  }
  async function runLint({ commitId, taskId, sessionId } = {}) { return run({ commitId, levels: ["lint"], taskId, sessionId }); }
  async function runTypecheck({ commitId, taskId, sessionId } = {}) { return run({ commitId, levels: ["typecheck"], taskId, sessionId }); }

  async function run({ commitId = `WORKTREE-${Date.now()}`, levels, taskId, sessionId }) {
    const plan = { commit_id: commitId, levels: ["focused"], checks: levels.map((type) => ({ type: type === "unit_test" ? "test" : type, command: commandFor(type, taskId), timeout_ms: timeoutMs })) };
    publish("verification.test_started", { commit_id: commitId, task_id: taskId, session_id: sessionId, levels });
    try {
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { const error = new ConfigurationError(`Test execution timed out after ${timeoutMs}ms.`); error.code = "TEST_TIMEOUT"; reject(error); }, timeoutMs); });
      const result = await Promise.race([verificationOrchestrator.run(plan, { taskId, sessionId, timeoutMs }), deadline]);
      clearTimeout(timer);
      publish("verification.result", result);
      return result;
    } catch (error) {
      if (error.code === "TEST_TIMEOUT") publish("process.timed_out", { task_id: taskId, session_id: sessionId, timeout_ms: timeoutMs });
      throw error;
    }
  }
  function commandFor(type, taskId) {
    if (type === "unit_test" && typeof taskId === "string" && /^(tests|test)\//.test(taskId)) return `node --test ${taskId}`;
    return { lint: "npm run lint", typecheck: "npm run typecheck", unit_test: "npm test" }[type] ?? "npm test";
  }
  function publish(type, payload) { const event = { type, project_root: projectRoot, payload }; publisher?.publish?.({ event_id: `EVT-${Date.now()}`, type, project_id: payload.project_id ?? "PROJECT-NODEFORGE", timestamp: new Date().toISOString(), payload, metadata: { source: "test-service", task_id: payload.task_id, session_id: payload.session_id } }); internalBus?.emit?.(type, event); }
}
