// Provides verification and commit tools for governed agent ticket work.
import { ConfigurationError } from "../shared/errors.js";
import { logEvent } from "../core/project-log-service.js";
import { createRuntimeLogger } from "../core/runtime-logger.js";
import { authorizeTool } from "./tool-authorization.js";

const error = (code, message, details = {}) => Object.assign(new ConfigurationError(message), { code, details });

// Starts Node-owned verification for the current agent execution.
export function createRunTestTool({ testService } = {}) {
  if (typeof testService?.startTests !== "function") throw new ConfigurationError("run_test requires Test Service startTests.");
  return Object.freeze({ name: "run_test", async execute(input = {}, context = {}) {
    if (Object.keys(input).length) throw error("INPUT_INVALID", "run_test accepts no arguments.");
    const started = testService.startTests({ commitId: context.commit_id ?? `WORKTREE-${context.task_id ?? Date.now()}`, taskId: context.task_id, sessionId: context.session_id, command: "node --test backend/tests/tools/*.test.js" });
    return { ...started, message: "Test job started. Poll check_test with this job_id until status is passed or failed." };
  }});
}

// Returns Node-owned verification results to the current agent execution.
export function createCheckTestTool({ testService } = {}) {
  if (typeof testService?.getTestResult !== "function") throw new ConfigurationError("check_test requires Test Service getTestResult.");
  return Object.freeze({ name: "check_test", async execute(input = {}, context = {}) {
    if (typeof input?.job_id !== "string" || !input.job_id.trim()) throw error("INPUT_INVALID", "check_test requires a job_id string returned by run_test.");
    const result = await testService.getTestResult({ jobId: input.job_id.trim(), taskId: context.task_id });
    if (result && typeof result === "object") context.verify_result = result;
    return result;
  }});
}

// Commits only paths changed during the current agent execution.
export function createCommitChangesTool({ gitService, logger = createRuntimeLogger({ logEvent }) } = {}) {
  if (typeof gitService?.commit !== "function") throw new ConfigurationError("commit_changes requires Git Service.");
  return Object.freeze({ name: "commit_changes", async execute(input = {}, context = {}) {
    const started = Date.now();
    let paths;
    try {
      authorizeTool("commit_changes", context);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "message") || typeof input.message !== "string" || !input.message.trim() || input.message.length > 200 || input.message.includes("\0")) throw error("INPUT_INVALID", "commit_changes requires a message of 1–200 characters and no other arguments.");
      paths = resolveCommitPaths(context);
      if (!paths.length) throw error("SCOPE_INVALID", "No changed files to commit; write_diff/edit_diff must run first.");
    } catch (cause) {
      emit("rejected", context, { error_code: cause.code ?? "COMMIT_INPUT_INVALID", error: cause.message, duration_ms: Date.now() - started });
      throw cause;
    }
    emit("started", context, { paths });
    try {
      const result = await gitService.commit(input.message.trim(), { paths });
      if (typeof result?.sha !== "string" || !result.sha) throw error("COMMIT_RESULT_INVALID", "Git Service did not return a commit SHA.");
      emit("completed", context, { paths, sha: result.sha, duration_ms: Date.now() - started });
      return result;
    } catch (cause) {
      emit("failed", context, { paths, error_code: cause.code ?? "COMMIT_FAILED", error: cause.message, duration_ms: Date.now() - started });
      throw cause;
    }
  }});

  // Records commit status without persisting the agent's commit message.
  function emit(phase, context, payload) {
    const status = phase === "completed" ? "success" : phase === "started" ? "started" : "failed";
    logger.emit({ event_name: `forge.commit_changes_${phase}`, level: status === "failed" ? "error" : "info", status,
      message: `commit_changes ${status}.`, task_id: context?.task_id ?? context?.taskId ?? "COMMIT-UNSCOPED",
      correlation_id: context?.correlation_id, source: "commit-changes-tool",
      ...(payload.error_code ? { error_code: payload.error_code } : {}),
      payload: { agent_id: context?.agent_identity?.agent_id, execution_id: context?.execution_id, ...payload }
    });
  }
}

// Resolves the exact paths approved for the current commit operation.
function resolveCommitPaths(context) {
  const changed = Array.isArray(context.changed_paths) ? context.changed_paths : [];
  if (changed.some((path) => typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".."))) throw error("SCOPE_INVALID", "Changed paths contain an unsafe project path.");
  const paths = [...new Set(changed)];
  const allowed = context.allowed_file_paths ?? context.allowedFilePaths;
  const prefixes = context.allowed_prefixes ?? context.allowedPrefixes;
  if (paths.length && !Array.isArray(allowed) && !Array.isArray(prefixes)) throw error("SCOPE_INVALID", "Node-approved file scope is missing.");
  if (paths.some((path) => !allowed?.includes(path) && !prefixes?.some((prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/$/, "")}/`)))) throw error("SCOPE_INVALID", "Changed path is outside the Node-approved file scope.");
  return paths;
}
