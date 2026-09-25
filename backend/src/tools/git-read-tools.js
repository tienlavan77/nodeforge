// Exposes Node-owned read-only Git status and diff tools for agent inspection.
import { logEvent } from "../core/project-log-service.js";
import { createRuntimeLogger } from "../core/runtime-logger.js";
import { ConfigurationError } from "../shared/errors.js";
import { authorizeTool } from "./tool-authorization.js";

const MAX_OUTPUT_BYTES = 256000;

// Creates scoped read-only Git tools using the existing project Git Service.
export function createGitReadTools({ gitService, logger = createRuntimeLogger({ logEvent }) } = {}) {
  if (typeof gitService?.status !== "function" || typeof gitService?.diffWorkingTree !== "function") throw new ConfigurationError("Git read tools require Git Service status and diffWorkingTree.");
  return Object.freeze({ git_status: createTool("git_status", "status"), git_diff: createTool("git_diff", "diffWorkingTree") });

  // Wraps each Git Service read with task authorization and project log events.
  function createTool(name, method) {
    return Object.freeze({ name, execute });

    // Returns a bounded native Git result while preserving failures for the agent.
    async function execute(input = {}, context = {}) {
      const started = Date.now();
      try {
        authorizeTool(name, context);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw invalidInput(`${name} accepts no arguments.`);
      } catch (error) {
        emit(name, "rejected", context, { error_code: error.code ?? "GIT_READ_INPUT_INVALID", error: error.message, duration_ms: Date.now() - started });
        throw error;
      }
      emit(name, "started", context, { operation: method });
      let stdout;
      try {
        stdout = await gitService[method]();
        if (typeof stdout !== "string") throw invalidInput("Git Service returned invalid output.");
        if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
          const error = invalidInput(`${name} output exceeds ${MAX_OUTPUT_BYTES} bytes.`);
          error.code = "GIT_READ_OUTPUT_TOO_LARGE";
          throw error;
        }
      } catch (error) {
        emit(name, "failed", context, { operation: method, error_code: error.code ?? "GIT_READ_FAILED", error: error.message, duration_ms: Date.now() - started });
        throw error;
      }
      const summary = name === "git_status" ? summarizeGitStatus(stdout) : { has_changes: stdout.length > 0 };
      emit(name, "completed", context, { operation: method, ...summary, stdout_bytes: Buffer.byteLength(stdout), duration_ms: Date.now() - started });
      return { stdout, stderr: "", exit_code: 0, ...summary };
    }
  }

  // Persists audit metadata without copying repository status or patch content.
  function emit(name, phase, context, payload) {
    const status = phase === "completed" ? "success" : phase === "started" ? "started" : "failed";
    logger.emit({ event_name: `forge.${name}_${phase}`, level: status === "failed" ? "error" : "info", status,
      message: `${name} ${status}.`, task_id: context?.task_id ?? context?.taskId ?? "GIT-READ-UNSCOPED",
      correlation_id: context?.correlation_id, source: "git-read-tools",
      ...(payload.error_code ? { error_code: payload.error_code } : {}),
      payload: { agent_id: context?.agent_identity?.agent_id, execution_id: context?.execution_id, ...payload }
    });
  }
}

// Summarizes porcelain Git status so the agent and project log can see clean or dirty state.
function summarizeGitStatus(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  return {
    working_tree: lines.length ? "dirty" : "clean", changed_files: lines.length,
    staged_files: lines.filter((line) => line[0] !== " " && line[0] !== "?").length,
    unstaged_files: lines.filter((line) => line[1] !== " " && line[1] !== "?").length,
    untracked_files: lines.filter((line) => line.startsWith("??")).length,
    conflicted_files: lines.filter((line) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(line)).length
  };
}

// Gives invalid Git tool input a stable code in logs and MCP responses.
function invalidInput(message) {
  const error = new ConfigurationError(message);
  error.code = "GIT_READ_INPUT_INVALID";
  return error;
}
