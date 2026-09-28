// Searches project source text with approved ripgrep flags under Forge task control.
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { logEvent } from "../core/project-log-service.js";
import { createRuntimeLogger } from "../core/runtime-logger.js";
import { ConfigurationError } from "../shared/errors.js";
import { authorizeTool, isAgentPathAllowed } from "./tool-authorization.js";

// Creates a scoped content search tool with the project's runtime logger.
export function createRgSearchTool({ projectRoot, codeCache, logger = createRuntimeLogger({ logEvent }), environment = process.env } = {}) {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) throw new ConfigurationError("rg_search requires an absolute project root.");
  return Object.freeze({ name: "rg_search", execute });

  // Validates the agent request before running ripgrep and records every outcome.
  async function execute(input = {}, context = {}) {
    const started = Date.now();
    let args;
    try {
      authorizeTool("rg_search", context);
      args = buildArgs(input);
      if (input.paths.some((path) => !isAgentPathAllowed(path, context))) throw invalidInput("rg_search path is outside the approved task scope.");
      await validatePaths(projectRoot, input.paths, environment);
    } catch (error) {
      emit("rejected", context, { error_code: error.code ?? "RG_SEARCH_INPUT_INVALID", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    emit("started", context, { command: safeCommand(args), cwd: projectRoot });
    let result;
    try {
      result = codeCache ? await searchCached(projectRoot, args, codeCache, environment, (error, path) => emit("cache_read_skipped", context, { error_code: error.code ?? "RG_SEARCH_CACHE_READ_FAILED", path })) : await runRipgrep(projectRoot, args, environment);
    } catch (error) {
      emit("failed", context, { command: safeCommand(args), cwd: projectRoot, error_code: error.code ?? "RG_SEARCH_SPAWN_FAILED", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    const status = result.exit_code === 0 || result.exit_code === 1 ? "completed" : "failed";
    emit(status, context, {
      command: safeCommand(args), cwd: projectRoot, exit_code: result.exit_code, signal: result.signal,
      stdout_bytes: Buffer.byteLength(result.stdout), stderr_bytes: Buffer.byteLength(result.stderr),
      duration_ms: Date.now() - started, ...(status === "failed" ? { error_code: "RG_SEARCH_EXIT_NONZERO" } : {})
    });
    return result;
  }

  // Persists search events without storing matched source lines or the query text.
  function emit(eventName, context, payload) {
    const status = eventName === "completed" ? "success" : eventName === "started" ? "started" : "failed";
    logger.emit({ event_name: `forge.rg_search_${eventName}`, level: status === "failed" ? "error" : "info", status,
      message: `rg_search ${status}.`, task_id: context?.task_id ?? context?.taskId ?? "RG-SEARCH-UNSCOPED",
      correlation_id: context?.correlation_id, source: "rg-search-tool",
      ...(payload.error_code ? { error_code: payload.error_code } : {}),
      payload: { agent_id: context?.agent_identity?.agent_id, execution_id: context?.execution_id, ...payload }
    });
  }
}

// Searches content supplied by the shared cache while ripgrep still selects files and matches lines.
async function searchCached(cwd, args, codeCache, environment, onSkipped) {
  const expression = args.indexOf("--regexp");
  const flags = args.slice(0, expression);
  const scopes = args.slice(expression + 3);
  const selectors = flags.filter((flag) => flag.startsWith("--glob=") || flag.startsWith("--iglob=") || flag.startsWith("--type=") || flag.startsWith("--type-not="));
  const matchFlags = flags.filter((flag) => !selectors.includes(flag));
  const listing = await runRipgrep(cwd, ["--files", "-0", ...selectors, "--", ...scopes], environment);
  if (listing.exit_code > 1 || listing.signal) return listing;
  const syntax = await runRipgrep(cwd, [...matchFlags, "--regexp", args[expression + 1], "--", "-"], environment, "");
  if (syntax.exit_code > 1 || syntax.signal) return syntax;
  let stdout = "";
  let stderr = "";
  let matched = false;
  for (const path of listing.stdout.split("\0").filter(Boolean)) {
    let source;
    try { source = await codeCache.read({ path }); }
    catch (error) {
      // A file may disappear or be protected after listing; never bypass File Service.
      if (error.code === "ENOENT" || error.code === "FILE_TOO_LARGE" || error.name === "ConfigurationError") { onSkipped(error, path); continue; }
      throw error;
    }
    const result = await runRipgrep(cwd, [...matchFlags, "--no-filename", "--regexp", args[expression + 1], "--", "-"], environment, source.content);
    if (result.stdout) stdout += result.stdout.split("\n").map((line, index, lines) => index === lines.length - 1 && !line ? "" : `${path}:${line}`).join("\n");
    stderr += result.stderr;
    if (result.exit_code === 0) matched = true;
    if (result.exit_code > 1 || result.signal) return { stdout, stderr, exit_code: result.exit_code, signal: result.signal };
  }
  return { stdout, stderr, exit_code: matched ? 0 : 1, signal: null };
}

// Records the command structure without persisting owner source search text.
function safeCommand(args) {
  const index = args.indexOf("--regexp");
  return ["rg", ...args.slice(0, index), "--regexp", "[pattern redacted]", "--", ...args.slice(index + 3)];
}

// Builds only the prioritized content search flags; regex remains a single argv item.
function buildArgs(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["pattern", "paths", "flags"].includes(key))) throw invalidInput("rg_search accepts pattern, paths, and flags only.");
  if (typeof input.pattern !== "string" || !input.pattern || input.pattern.length > 500 || input.pattern.includes("\0")) throw invalidInput("rg_search pattern must contain 1–500 characters and no NUL byte.");
  if (!Array.isArray(input.paths) || !input.paths.length || input.paths.some((path) => typeof path !== "string" || !/^[A-Za-z0-9_-]+$/.test(path))) throw invalidInput("rg_search paths must be top-level project directories.");
  const flags = input.flags ?? [];
  if (!Array.isArray(flags) || flags.some((flag) => typeof flag !== "string" || !isAllowedFlag(flag))) throw invalidInput("rg_search received an unsupported flag.");
  return [...flags, "--regexp", input.pattern, "--", ...input.paths];
}

// Keeps optional flags within line numbering, matching, narrowing, and per-file limits.
function isAllowedFlag(flag) {
  return ["-n", "--line-number", "-i", "--ignore-case", "-F", "--fixed-strings", "-w", "--word-regexp"].includes(flag)
    || /^--(?:i?glob)=![^!].*$/s.test(flag)
    || /^--type(?:-not)?=[A-Za-z0-9_-]+$/.test(flag)
    || /^--max-count=[1-9]\d{0,3}$/.test(flag);
}

// Rejects symlink paths, directories outside the real project root, and absent scopes.
async function validatePaths(projectRoot, paths, environment) {
  const root = await realpath(projectRoot);
  const listed = await runRipgrep(projectRoot, ["--files"], environment);
  if (listed.exit_code > 1 || listed.signal) throw invalidInput("rg_search could not verify project ignore rules.");
  for (const path of paths) {
    const candidate = join(projectRoot, path);
    const stat = await lstat(candidate);
    const target = await realpath(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative(root, target).startsWith("..") || isAbsolute(relative(root, target))) throw invalidInput("rg_search path must be a real project directory.");
    if (!listed.stdout.split("\n").some((file) => file.startsWith(`${path}/`))) throw invalidInput("rg_search path is ignored or has no searchable files.");
  }
}

// Gives invalid agent input a stable code in the MCP response and project log.
function invalidInput(message) {
  const error = new ConfigurationError(message);
  error.code = "RG_SEARCH_INPUT_INVALID";
  return error;
}

// Captures native ripgrep output while disabling inherited config and shell expansion.
function runRipgrep(cwd, args, environment, input) {
  return new Promise((resolve, reject) => {
    const env = { ...environment };
    delete env.RIPGREP_CONFIG_PATH;
    delete env.RG_CONFIG_PATH;
    const child = spawn(rgPath, args, { cwd, env, shell: false, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    if (input !== undefined) {
      child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
      child.stdin.end(input);
    }
    child.once("close", (code, signal) => resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exit_code: code, signal }));
  });
}
