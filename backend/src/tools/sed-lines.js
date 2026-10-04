// Reads a bounded source line window with sed for Forge agent inspection.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { logEvent } from "../core/project-log-service.js";
import { createRuntimeLogger } from "../core/runtime-logger.js";
import { ConfigurationError } from "../shared/errors.js";
import { authorizeTool, isAgentPathAllowed } from "./tool-authorization.js";

const MAX_LINES = 80;
const MAX_OUTPUT_BYTES = 200000;

// Creates a read-only sed tool that can reuse read_file's symbol lookup.
export function createSedLinesTool({ projectRoot, fileService, codeCache, symbolLookup, logger = createRuntimeLogger({ logEvent }), environment = process.env } = {}) {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) throw new ConfigurationError("sed_lines requires an absolute project root.");
  return Object.freeze({ name: "sed_lines", execute });

  // Validates scope and line range, runs sed, and records every outcome.
  async function execute(input = {}, context = {}) {
    const started = Date.now();
    let args;
    let normalized;
    try {
      authorizeTool("sed_lines", context);
      normalized = normalizeInput(input, projectRoot);
      args = buildArgs(normalized);
      if (!isAgentPathAllowed(normalized.path, context) || (fileService && !approvedPath(normalized.path, context))) throw invalidInput("sed_lines path is outside the Node-approved file scope.");
      await validatePath(projectRoot, normalized.path, environment, context);
    } catch (error) {
      emit("rejected", context, { error_code: error.code ?? "SED_LINES_INPUT_INVALID", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    emit("started", context, { command: ["sed", ...args], cwd: projectRoot });
    let result;
    try {
      result = codeCache ? await readCachedLines(codeCache, normalized) : await runSed(projectRoot, args, environment);
    } catch (error) {
      emit("failed", context, { command: ["sed", ...args], cwd: projectRoot, error_code: error.code ?? "SED_LINES_SPAWN_FAILED", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    const success = result.exit_code === 0 && !result.signal;
    emit(success ? "completed" : "failed", context, {
      command: ["sed", ...args], cwd: projectRoot, exit_code: result.exit_code, signal: result.signal,
      stdout_bytes: Buffer.byteLength(result.stdout), stderr_bytes: Buffer.byteLength(result.stderr),
      duration_ms: Date.now() - started, ...(!success ? { error_code: "SED_LINES_EXIT_NONZERO" } : {})
    });
    if (!success) return result;
    let metadata = {};
    if (fileService) {
      try {
        const file = codeCache ? await codeCache.read({ path: normalized.path }) : await fileService.readForIndex({ path: normalized.path });
        if (typeof file?.content !== "string") throw invalidInput("sed_lines could not verify the file checksum.");
        metadata = { sha256: file.sha256 ?? `sha256:${createHash("sha256").update(file.content, "utf8").digest("hex")}`, total_lines: file.content.split("\n").length };
      } catch (error) {
        emit("failed", context, { path: normalized.path, error_code: error.code ?? "SED_CHECKSUM_FAILED", error: error.message });
        throw error;
      }
    }
    if (typeof symbolLookup !== "function") return { ...result, ...metadata };
    try {
      const symbols = await symbolLookup(normalized.path);
      return { ...result, ...metadata, symbol_map: Array.isArray(symbols) ? symbols : [], symbol_map_verified: false };
    } catch (error) {
      emit("symbol_lookup_failed", context, { path: normalized.path, error_code: error.code ?? "SED_SYMBOL_LOOKUP_FAILED", error: error.message });
      return { ...result, ...metadata };
    }
  }

  // Persists execution metadata without logging source text or symbol contents.
  function emit(eventName, context, payload) {
    const status = eventName === "completed" ? "success" : eventName === "started" ? "started" : "failed";
    logger.emit({ event_name: `forge.sed_lines_${eventName}`, level: status === "failed" ? "error" : "info", status,
      message: `sed_lines ${status}.`, task_id: context?.task_id ?? context?.taskId ?? "SED-LINES-UNSCOPED",
      correlation_id: context?.correlation_id, source: "sed-lines-tool",
      ...(payload.error_code ? { error_code: payload.error_code } : {}),
      payload: { agent_id: context?.agent_identity?.agent_id, execution_id: context?.execution_id, ...payload }
    });
  }
}

// Normalizes harmless agent path/number variants before applying the strict scope checks.
function normalizeInput(input, projectRoot) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const pathValue = input.path ?? input.file_path;
  let path = typeof pathValue === "string" ? pathValue.trim() : pathValue;
  if (typeof path === "string" && path.startsWith(`${projectRoot}/`)) path = path.slice(projectRoot.length + 1);
  if (typeof path === "string" && path.startsWith("./")) path = path.slice(2);
  const number = (value) => typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return { path, start_line: number(input.start_line ?? input.startLine), end_line: number(input.end_line ?? input.endLine) };
}

// Returns sed-compatible line output from the shared current-source cache.
async function readCachedLines(codeCache, input) {
  const file = await codeCache.read({ path: input.path });
  const lines = file.content.split("\n");
  return { stdout: lines.slice(input.start_line - 1, input.end_line).join("\n") + (input.start_line <= lines.length ? "\n" : ""), stderr: "", exit_code: 0, signal: null, cache: file.cache, index_status: file.index_status };
}

// Allows agent reads only inside the file scope issued by Node for the task.
function approvedPath(path, context) {
  const files = context.allowed_file_paths ?? context.allowedFilePaths ?? [];
  const prefixes = context.allowed_prefixes ?? context.allowedPrefixes ?? [];
  return files.includes(path) || prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/$/, "")}/`));
}

// Builds the exact read-only sed line expression from bounded numeric input.
function buildArgs(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["path", "start_line", "end_line"].includes(key))) throw invalidInput("sed_lines accepts path, start_line, and end_line only.");
  if (typeof input.path !== "string" || !input.path || isAbsolute(input.path) || input.path.includes("\\") || input.path.includes("\0") || input.path.split("/").some((part) => !part || part === "." || part === "..")) throw invalidInput("sed_lines path must be a safe relative project file.");
  if (!Number.isSafeInteger(input.start_line) || input.start_line < 1 || !Number.isSafeInteger(input.end_line) || input.end_line < input.start_line || input.end_line - input.start_line + 1 > MAX_LINES) throw invalidInput(`sed_lines requires a valid window of at most ${MAX_LINES} lines.`);
  return ["-n", `${input.start_line},${input.end_line}p`, "--", input.path];
}

// Checks every path segment and ripgrep's baseline listing before sed reads it.
async function validatePath(projectRoot, path, environment, context = {}) {
  const root = await realpath(projectRoot);
  let current = projectRoot;
  for (const part of path.split("/")) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw invalidInput("sed_lines cannot read symlink paths.");
  }
  const target = await realpath(current);
  const within = relative(root, target);
  if (!within || within.startsWith("..") || isAbsolute(within) || !(await lstat(current)).isFile()) throw invalidInput("sed_lines path must be a regular project file.");
  // Explicit Node-issued file grants may include internal workflow files that
  // stay Git-ignored. The grant is already checked by isAgentPathAllowed and
  // approvedPath, so do not let ripgrep's ignore rules reject that exact file.
  if (approvedPath(path, context)) return;
  const listed = await listProjectFiles(projectRoot, environment);
  if (!listed.has(path)) throw invalidInput("sed_lines path is hidden or ignored by project rules.");
}

// Uses ripgrep's default ignore rules without inherited config to approve readable files.
function listProjectFiles(cwd, environment) {
  return new Promise((resolve, reject) => {
    const env = { ...environment };
    delete env.RIPGREP_CONFIG_PATH;
    delete env.RG_CONFIG_PATH;
    const child = spawn(rgPath, ["--files", "-0"], { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 || code === 1 ? resolve(new Set(Buffer.concat(stdout).toString("utf8").split("\0"))) : reject(invalidInput(`Could not verify project ignore rules: ${signal ?? Buffer.concat(stderr).toString("utf8").trim()}`)));
  });
}

// Gives unsafe reads a stable error code for the agent and project log.
function invalidInput(message) {
  const error = new ConfigurationError(message);
  error.code = "SED_LINES_INPUT_INVALID";
  return error;
}

// Runs sed without a shell and rejects source windows above the response budget.
function runSed(cwd, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn("sed", args, { cwd, env: { ...environment }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => { bytes += chunk.length; stdout.push(chunk); if (bytes > MAX_OUTPUT_BYTES) child.kill(); });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (bytes > MAX_OUTPUT_BYTES) {
        const error = invalidInput(`sed_lines output exceeds ${MAX_OUTPUT_BYTES} bytes.`);
        error.code = "SED_LINES_OUTPUT_TOO_LARGE";
        reject(error);
      } else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exit_code: code, signal });
    });
  });
}
