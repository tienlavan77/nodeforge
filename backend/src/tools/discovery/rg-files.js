// Runs ripgrep file listing with approved flags under Node ownership for auditable agent discovery.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { logEvent } from "../../core/project-log-service.js";
import { createRuntimeLogger } from "../../core/runtime-logger.js";
import { ConfigurationError } from "../../shared/errors.js";
import { authorizeTool, isAgentPathAllowed } from "../governance/tool-authorization.js";
import { assertExecutionFileAccess } from "../execution-file-access.js";
import { assertRoleFileAccess } from "../../infrastructure/filesystem/file-service-role-policy.js";

// Creates a scoped Forge tool that lists files from the approved project root.
export function createRgFilesTool({ projectRoot, logger = createRuntimeLogger({ logEvent }), environment = process.env, toolName = "rg_files" } = {}) {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) throw new ConfigurationError("rg_files requires an absolute project root.");
  return Object.freeze({ name: toolName, execute });

  // Lists files using only approved ripgrep flags in the order provided by the agent.
  async function execute(input = {}, context = {}) {
    const started = Date.now();
    let args;
    try {
      authorizeTool(toolName, context);
      args = buildArgs(input);
      if (context.file_access_version === 2) args.push("-0");
    } catch (error) {
      emit("forge.rg_files_rejected", "failed", context, { error_code: error.code ?? "RG_FILES_INPUT_INVALID", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    emit("forge.rg_files_started", "started", context, { command: ["rg", ...args], cwd: projectRoot });
    let result;
    try {
      result = await runRipgrep(projectRoot, args, environment);
      if (args.some((flag) => /^--i?glob=[^!]/.test(flag))) {
        // Positive selectors must narrow normal discovery, never revive ignored or hidden files.
        const baseline = await runRipgrep(projectRoot, ["--files", "-0"], environment);
        if (baseline.exit_code > 1 || baseline.signal) throw invalidInput("Could not verify project ignore rules.");
        const files = new Set(baseline.stdout.split("\0"));
        const separator = context.file_access_version === 2 ? "\0" : "\n";
        result.stdout = result.stdout.split(separator).filter((path) => files.has(path)).join(separator);
        if (result.stdout) result.stdout += separator;
      }
      if (context.agent_identity?.role === "system_engineer" && await hasForgeDirectory(projectRoot)) {
        const forge = await runRipgrep(projectRoot, ["--files", "--hidden", "--no-ignore", ...args.slice(1), "--", ".forge"], environment);
        if (forge.exit_code > 1 && !forge.stderr.includes("No such file or directory")) throw invalidInput(forge.stderr);
        result.stdout += forge.stdout;
      }
      result.stdout = result.stdout.split(context.file_access_version === 2 ? "\0" : "\n").filter((path) => {
        if (!path) return false;
        const normalized = path.replace(/^\.\//, "");
        if (["coder", "reviewer"].includes(context.agent_identity?.role)) {
          try { assertRoleFileAccess(context.agent_identity.role, "read", normalized); }
          catch (error) { if (error.code === "FILE_ROLE_FORBIDDEN") return false; throw error; }
        }
        return isAgentPathAllowed(normalized, context);
      }).join("\n");
      if (result.stdout) result.stdout += "\n";
      if (context.file_access_version === 2 && result.stderr) result.stderr = "File discovery encountered an error within the requested scope.";
    } catch (error) {
      emit("forge.rg_files_failed", "failed", context, { command: ["rg", ...args], cwd: projectRoot, error_code: error.code ?? "RG_FILES_SPAWN_FAILED", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    const success = result.exit_code === 0 || result.exit_code === 1;
    assertExecutionFileAccess(context);
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
      event_name: eventName.replace("rg_files", toolName), level: status === "failed" ? "error" : "info", status,
      message: `${toolName} ${status}.`, task_id: context?.task_id ?? context?.taskId ?? "RG-FILES-UNSCOPED",
      correlation_id: context?.correlation_id, source: `${toolName.replaceAll("_", "-")}-tool`,
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
  if (flag.includes("..") || flag.includes("\0")) return false;
  return /^--(?:i?glob)=!?[^!].*$/s.test(flag)
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

// Prevents SE discovery from following a Forge root symlink outside the project.
async function hasForgeDirectory(projectRoot) {
  try { const entry = await lstat(join(projectRoot, ".forge")); return entry.isDirectory() && !entry.isSymbolicLink(); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
