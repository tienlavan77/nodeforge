// Business purpose: Provides the Node-mediated Command & Archive Service (`run_command`) for System Engineer and Coder roles without shell interpolation or sensitive environment leakage.
// Technical description: Delegates argument/archive policy validation to command-policy.js, constructs a filtered child environment, spawns processes with shell: false, tracks remaining deadline across archive preflight and execution, and redacts/bounds stdout and stderr.

import { spawn } from "node:child_process";
import { ConfigurationError } from "../../shared/errors.js";
import {
  ALLOWED_COMMANDS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_STREAM_BYTES,
  assertCommandArgSymlinkSafety,
  assertNoSymlinkEscape,
  commandError,
  isProtectedInternalSegment,
  resolveProjectContainedPath,
  validateArchiveOperation,
  validateRunCommandInput
} from "./command-policy.js";

export {
  ALLOWED_COMMANDS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_STREAM_BYTES,
  assertCommandArgSymlinkSafety,
  assertNoSymlinkEscape,
  commandError,
  isProtectedInternalSegment,
  resolveProjectContainedPath,
  validateArchiveOperation,
  validateRunCommandInput
};

const SECRET_ASSIGNMENT_PATTERN = /((?:api[_-]?key|credential|secret|password|passwd|token|authorization|private[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;}\]]+)/gi;
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const SAFE_ENV_KEYS = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "TZ", "NODE_ENV", "COLORTERM", "TERM", "SYSTEMROOT", "COMSPEC"]);
const SENSITIVE_ENV_NAME_PATTERN = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|COOKIE|SESSION|DATABASE_URL|REDIS_URL)/i;

// Business purpose: Builds a sanitized environment object for child processes so credentials, API keys, and tokens in process.env are never exposed to commands.
// Technical description: Copies only allowlisted system/locale variables from sourceEnv that do not match sensitive key patterns, and sets CI="true" and FORCE_COLOR="0".
export function buildFilteredCommandEnv(sourceEnv = process.env) {
  const filtered = { CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" };
  if (!sourceEnv || typeof sourceEnv !== "object") return filtered;
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value !== "string") continue;
    if (SENSITIVE_ENV_NAME_PATTERN.test(key)) continue;
    if (SAFE_ENV_KEYS.has(key) || key.startsWith("LC_") || key.startsWith("NPM_CONFIG_CACHE") || key.startsWith("PNPM_HOME")) {
      filtered[key] = value;
    }
  }
  return filtered;
}

// Business purpose: Redacts credentials and sensitive tokens from command stdout/stderr before returning output to agents or logs.
// Technical description: Replaces key/value secret assignments and Bearer tokens with [REDACTED] and bounds output to maxBytes.
export function redactCommandOutput(rawText, maxBytes = MAX_STREAM_BYTES) {
  const source = String(rawText ?? "");
  const redacted = source
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]")
    .replace(BEARER_PATTERN, "$1[REDACTED]");
  const byteLength = Buffer.byteLength(redacted, "utf8");
  if (byteLength <= maxBytes) {
    return { text: redacted, truncated: false };
  }
  const sliced = Buffer.from(redacted, "utf8").subarray(0, maxBytes).toString("utf8");
  return { text: `${sliced}\n...[truncated]`, truncated: true };
}

// Business purpose: Creates the Node-mediated Command & Archive Service for governed execution of project toolchains.
// Technical description: Spawns processes with shell: false, enforces timeout_ms and AbortSignal across preflight and main execution, validates archive safety, and redacts/bounds stdout and stderr.
export function createNodeCommandService({ projectRoot, spawnProcess = defaultSpawnProcess } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot) {
    throw new ConfigurationError("Node Command Service requires a projectRoot.");
  }

  return Object.freeze({
    executeCommand,
    validateInput: (input) => validateRunCommandInput(input, projectRoot)
  });

  // Business purpose: Validates and runs one structured project command to completion through Node within a shared deadline budget.
  // Technical description: Resolves executable (using process.execPath for node and --no-install for npx), enforces symlink and Zip Slip guards with remaining timeout and signal, and returns bounded output.
  async function executeCommand(input = {}, { signal } = {}) {
    const validated = validateRunCommandInput(input, projectRoot);
    await assertNoSymlinkEscape(projectRoot, validated.cwdAbsolute);
    await assertCommandArgSymlinkSafety(projectRoot, validated.cwdAbsolute, validated.command, validated.args);

    const started = Date.now();
    const deadlineAt = started + validated.timeoutMs;
    const remainingTimeoutMs = () => deadlineAt - Date.now();

    if (validated.command === "zip" || validated.command === "unzip") {
      await validateArchiveOperation(
        validated.command,
        validated.args,
        validated.cwdAbsolute,
        projectRoot,
        (cmd, cmdArgs, opts) => spawnProcess(cmd, cmdArgs, { ...opts, signal: opts?.signal ?? signal }),
        { remainingTimeoutMs, signal }
      );
    }

    const leftMs = remainingTimeoutMs();
    if (leftMs <= 0) {
      throw commandError("COMMAND_TIMEOUT", `Command exceeded timeout of ${validated.timeoutMs}ms.`);
    }

    const executable = validated.command === "node" ? process.execPath : validated.command;
    const finalArgs = validated.command === "npx" && !validated.args.includes("--no-install")
      ? ["--no-install", ...validated.args]
      : validated.args;

    const rawResult = await spawnProcess(executable, finalArgs, {
      cwd: validated.cwdAbsolute,
      timeoutMs: leftMs,
      signal
    });
    const durationMs = Date.now() - started;
    const out = redactCommandOutput(rawResult.stdout, MAX_STREAM_BYTES);
    const err = redactCommandOutput(rawResult.stderr, MAX_STREAM_BYTES);

    return {
      command: validated.command,
      args: validated.args,
      cwd: validated.cwd,
      exit_code: rawResult.exitCode,
      duration_ms: durationMs,
      stdout: out.text,
      stderr: err.text,
      truncated: Boolean(rawResult.truncated || out.truncated || err.truncated)
    };
  }
}

// Business purpose: Spawns a child process directly with shell: false, sanitized environment, byte caps, and timeout/AbortSignal cancellation.
// Technical description: Uses node:child_process spawn with stdio pipes and buildFilteredCommandEnv, kills the process on timeout or abort, and collects bounded stdout/stderr buffers.
function defaultSpawnProcess(executable, args, { cwd, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(commandError("COMMAND_ABORTED", "Command execution was aborted before start."));
      return;
    }
    if (timeoutMs <= 0) {
      rejectPromise(commandError("COMMAND_TIMEOUT", `Command exceeded timeout of ${timeoutMs}ms.`));
      return;
    }
    const env = buildFilteredCommandEnv(process.env);
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      rejectPromise(commandError("COMMAND_SPAWN_FAILED", `Failed to start ${executable}: ${error.message}`));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let streamTruncated = false;
    let timedOut = false;
    let aborted = false;
    const captureCap = MAX_STREAM_BYTES * 2;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    // Business purpose: Terminates the spawned child process immediately when the caller's AbortSignal fires.
    // Technical description: Marks aborted state and sends SIGKILL to the child process.
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (stdoutBytes < captureCap) {
        stdoutChunks.push(buf.subarray(0, captureCap - stdoutBytes));
      } else {
        streamTruncated = true;
      }
      stdoutBytes += buf.length;
      if (stdoutBytes > MAX_STREAM_BYTES) streamTruncated = true;
    });

    child.stderr?.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (stderrBytes < captureCap) {
        stderrChunks.push(buf.subarray(0, captureCap - stderrBytes));
      } else {
        streamTruncated = true;
      }
      stderrBytes += buf.length;
      if (stderrBytes > MAX_STREAM_BYTES) streamTruncated = true;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      rejectPromise(commandError("COMMAND_SPAWN_FAILED", `Failed to execute ${executable}: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      if (aborted) {
        rejectPromise(commandError("COMMAND_ABORTED", "Command execution was aborted."));
        return;
      }
      if (timedOut) {
        rejectPromise(commandError("COMMAND_TIMEOUT", `Command exceeded timeout of ${timeoutMs}ms.`));
        return;
      }
      resolvePromise({
        exitCode: typeof code === "number" ? code : 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        truncated: streamTruncated
      });
    });
  });
}
