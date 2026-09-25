// Runs ripgrep file listing with approved flags under Node ownership for auditable agent discovery.
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { logEvent } from "../core/project-log-service.js";
import { createRuntimeLogger } from "../core/runtime-logger.js";
import { ConfigurationError } from "../shared/errors.js";
import { authorizeTool } from "./tool-authorization.js";

// Creates a scoped Forge tool that lists files from the approved project root.
export function createRgFilesTool({ projectRoot, logger = createRuntimeLogger({ logEvent }), environment = process.env } = {}) {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) throw new ConfigurationError("rg_files requires an absolute project root.");
  return Object.freeze({ name: "rg_files", execute });

  // Lists files using only approved ripgrep flags in the order provided by the agent.
  async function execute(input = {}, context = {}) {
    const started = Date.now();
    let args;
    try {
      authorizeTool("rg_files", context);
      args = buildArgs(input);
    } catch (error) {
      emit("forge.rg_files_rejected", "failed", context, { error_code: error.code ?? "RG_FILES_INPUT_INVALID", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    emit("forge.rg_files_started", "started", context, { command: ["rg", ...args], cwd: projectRoot });
    let result;
    try {
      result = await runRipgrep(projectRoot, args, environment);
    } catch (error) {
      emit("forge.rg_files_failed", "failed", context, { command: ["rg", ...args], cwd: projectRoot, error_code: error.code ?? "RG_FILES_SPAWN_FAILED", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    const success = result.exit_code === 0 || result.exit_code === 1;
    emit(success ? "forge.rg_files_completed" : "forge.rg_files_failed", success ? "success" : "failed", context, {
      command: ["rg", ...args], cwd: projectRoot, exit_code: result.exit_code, signal: result.signal,
      stdout_bytes: Buffer.byteLength(result.stdout), stderr_bytes: Buffer.byteLength(result.stderr),
      duration_ms: Date.now() - started, ...(!success ? { error_code: "RG_FILES_EXIT_NONZERO" } : {})
    });
    return result;
  }

  // Records scoped execution and failures through the project's runtime log service.
  function emit(eventName, status, context, payload) {
    logger.emit({
      event_name: eventName, level: status === "failed" ? "error" : "info", status,
      message: `rg_files ${status}.`, task_id: context?.task_id ?? context?.taskId ?? "RG-FILES-UNSCOPED",
      correlation_id: context?.correlation_id, source: "rg-files-tool",
      ...(payload.error_code ? { error_code: payload.error_code } : {}),
      payload: { agent_id: context?.agent_identity?.agent_id, execution_id: context?.execution_id, ...payload }
    });
  }
}

// Preserves native ripgrep flag syntax while rejecting operands and flags outside file discovery.
function buildArgs(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "flags")) throw invalidInput("rg_files accepts only a flags array.");
  const flags = input.flags === undefined ? [] : input.flags;
  if (!Array.isArray(flags) || flags.some((flag) => typeof flag !== "string" || !isAllowedFlag(flag))) throw invalidInput("rg_files received an unsupported flag.");
  return ["--files", ...flags];
}

// Gives invalid agent flags a stable code for the project log and MCP response.
function invalidInput(message) {
  const error = new ConfigurationError(message);
  error.code = "RG_FILES_INPUT_INVALID";
  return error;
}

// Allows only flags that narrow the default file list or sort its output.
function isAllowedFlag(flag) {
  return /^--(?:i?glob)=![^!].*$/s.test(flag)
    || /^--max-depth=\d+$/.test(flag)
    || /^--type(?:-not)?=[A-Za-z0-9_-]+$/.test(flag)
    || flag === "--sort=path";
}

// Runs ripgrep without inherited config flags that could bypass project ignore rules.
function runRipgrep(cwd, args, environment) {
  return new Promise((resolve, reject) => {
    const env = { ...environment };
    delete env.RIPGREP_CONFIG_PATH;
    delete env.RG_CONFIG_PATH;
    const child = spawn(rgPath, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exit_code: code, signal }));
  });
}
