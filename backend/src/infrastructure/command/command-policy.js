// Business purpose: Enforces Node-mediated command and archive safety policies so agents cannot bypass the Git toolset, execute inline child processes, escape projectRoot, or trigger Zip Slip attacks.
// Technical description: Validates structured command arguments, blocks direct/indirect git invocations and inline process spawning, resolves contained paths, and inspects archive entries with propagated deadlines and AbortSignals.

import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";

export const ALLOWED_COMMANDS = Object.freeze(["node", "pnpm", "npm", "npx", "php", "zip", "unzip"]);
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const MAX_COMMAND_TIMEOUT_MS = 180_000;
export const MAX_STREAM_BYTES = 8 * 1024;
const MAX_ARGS = 64;

const FORBIDDEN_PNPM_SUBCOMMANDS = new Set(["publish", "login", "logout", "dlx"]);
const FORBIDDEN_NPM_SUBCOMMANDS = new Set(["publish", "login", "logout", "adduser", "owner", "token"]);
const SAFE_NPX_BINARIES = new Set(["tsc", "eslint", "prettier", "vitest", "jest", "mocha", "playwright", "prisma", "next", "tsx", "ajv"]);
const INLINE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader", "--experimental-loader"]);
const INLINE_EXEC_PATTERNS = /\b(child_process|spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|shell_exec|proc_open|passthru|popen|pcntl_exec|system)\b|\bprocess\.binding\b|['"`]git['"`]/i;

// Business purpose: Produces a typed ConfigurationError with a stable error code for command validation and execution failures.
// Technical description: Attaches error.code to a ConfigurationError instance.
export function commandError(code, message) {
  return Object.assign(new ConfigurationError(message), { code });
}

// Business purpose: Checks whether a normalized relative path touches .git/ or .forge/ internal directories.
// Technical description: Splits POSIX path segments and checks if any segment equals .git or .forge.
export function isProtectedInternalSegment(relPath) {
  const segments = String(relPath ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  return segments.includes(".git") || segments.includes(".forge");
}

// Business purpose: Validates and resolves a project-relative path so commands and archives cannot escape projectRoot or mutate .git/ and .forge/.
// Technical description: Rejects NUL bytes, absolute paths outside projectRoot, parent traversal (..), and protected .git/.forge segments when forbidProtected is true.
export function resolveProjectContainedPath(projectRoot, candidatePath, { forbidProtected = true, label = "path" } = {}) {
  if (typeof candidatePath !== "string" || !candidatePath.trim()) {
    throw commandError("COMMAND_PATH_INVALID", `Invalid ${label}: expected non-empty path string.`);
  }
  if (candidatePath.includes("\0")) {
    throw commandError("COMMAND_PATH_INVALID", `Invalid ${label}: NUL bytes are forbidden.`);
  }
  const trimmed = candidatePath.trim();
  const rootResolved = resolve(projectRoot);
  if (isAbsolute(trimmed)) {
    const absResolved = resolve(trimmed);
    const relFromRoot = relative(rootResolved, absResolved).split(sep).join("/");
    if (relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) {
      throw commandError("COMMAND_PATH_OUTSIDE_PROJECT", `Forbidden ${label} outside projectRoot: ${trimmed}`);
    }
    if (forbidProtected && isProtectedInternalSegment(relFromRoot)) {
      throw commandError("COMMAND_PROTECTED_PATH", `Forbidden ${label} inside protected directory (.git or .forge): ${trimmed}`);
    }
    return { absolutePath: absResolved, relativePath: relFromRoot || "." };
  }
  const parts = trimmed.replace(/\\/g, "/").split("/");
  if (parts.includes("..")) {
    throw commandError("COMMAND_PATH_OUTSIDE_PROJECT", `Forbidden parent traversal (..) in ${label}: ${trimmed}`);
  }
  const absResolved = resolve(rootResolved, trimmed);
  const relFromRoot = relative(rootResolved, absResolved).split(sep).join("/");
  if (relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) {
    throw commandError("COMMAND_PATH_OUTSIDE_PROJECT", `Forbidden ${label} outside projectRoot: ${trimmed}`);
  }
  const normalizedRel = relFromRoot || ".";
  if (forbidProtected && isProtectedInternalSegment(normalizedRel)) {
    throw commandError("COMMAND_PROTECTED_PATH", `Forbidden ${label} inside protected directory (.git or .forge): ${trimmed}`);
  }
  return { absolutePath: absResolved, relativePath: normalizedRel };
}

// Business purpose: Verifies that an existing path and its ancestors inside projectRoot do not traverse a symlink pointing outside projectRoot.
// Technical description: Walks path segments from projectRoot, checking lstat and realpath when segments exist on disk.
export async function assertNoSymlinkEscape(projectRoot, targetAbsPath) {
  const rootReal = await realpath(projectRoot).catch(() => resolve(projectRoot));
  const rel = relative(resolve(projectRoot), targetAbsPath).split(sep).filter(Boolean);
  let current = resolve(projectRoot);
  for (const part of rel) {
    current = resolve(current, part);
    const stat = await lstat(current).catch(() => null);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      const targetReal = await realpath(current).catch(() => null);
      if (!targetReal) throw commandError("COMMAND_SYMLINK_ESCAPE", `Broken symlink encountered: ${part}`);
      const relReal = relative(rootReal, targetReal).split(sep).join("/");
      if (relReal.startsWith("..") || isAbsolute(relReal) || isProtectedInternalSegment(relReal)) {
        throw commandError("COMMAND_SYMLINK_ESCAPE", `Symlink escapes projectRoot or points into protected directory: ${part}`);
      }
    }
  }
}

// Business purpose: Validates structured command and argument rules before spawning any child process.
// Technical description: Enforces capability allowlist, rejects direct or indirect git tokens, checks per-tool forbidden flags/subcommands, and validates path arguments against projectRoot.
export function validateRunCommandInput(input, projectRoot) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw commandError("COMMAND_INPUT_INVALID", "run_command requires a structured input object.");
  }
  const allowedKeys = new Set(["command", "args", "cwd", "timeout_ms"]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw commandError("COMMAND_INPUT_INVALID", `Unexpected run_command field: ${key}.`);
  }
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (command === "git") {
    throw commandError("COMMAND_GIT_FORBIDDEN", "Direct git execution in run_command is forbidden; use the governed Forge Git Tools.");
  }
  if (!ALLOWED_COMMANDS.includes(command)) {
    throw commandError("COMMAND_NOT_ALLOWED", `Unsupported command '${command}'. Allowed commands: ${ALLOWED_COMMANDS.join(", ")}.`);
  }
  const args = input.args === undefined ? [] : input.args;
  if (!Array.isArray(args) || args.length === 0 || args.length > MAX_ARGS || args.some((arg) => typeof arg !== "string" || !arg.length || arg.length > 1000 || arg.includes("\0"))) {
    throw commandError("COMMAND_ARGS_INVALID", `run_command requires 'args' as an array of 1..${MAX_ARGS} non-empty strings.`);
  }
  const rawCwd = input.cwd === undefined ? "." : input.cwd;
  const resolvedCwd = resolveProjectContainedPath(projectRoot, rawCwd, { forbidProtected: true, label: "cwd" });
  const timeoutMs = input.timeout_ms === undefined ? DEFAULT_COMMAND_TIMEOUT_MS : input.timeout_ms;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    throw commandError("COMMAND_TIMEOUT_INVALID", `timeout_ms must be an integer between 100 and ${MAX_COMMAND_TIMEOUT_MS}.`);
  }
  validatePerCommandPolicy(command, args, resolvedCwd.absolutePath, projectRoot);
  return { command, args: [...args], cwd: resolvedCwd.relativePath, cwdAbsolute: resolvedCwd.absolutePath, timeoutMs };
}

// Business purpose: Enforces per-command argument restrictions so package managers, interpreters, and archive tools stay within safe boundaries.
// Technical description: Rejects indirect git invocations, inline process execution, parent traversal, protected .git/.forge references, global/publish/auth flags, and php -S.
function validatePerCommandPolicy(command, args, cwdAbsolute, projectRoot) {
  for (const arg of args) {
    const trimmedArg = arg.trim();
    if (/^(?:.*[\\/])?git(?:\.exe)?$/i.test(trimmedArg)) {
      throw commandError("COMMAND_GIT_FORBIDDEN", `Indirect git execution ('${arg}') in run_command is forbidden; use the governed Forge Git Tools.`);
    }
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(arg)) {
      throw commandError("COMMAND_PATH_OUTSIDE_PROJECT", `Argument contains forbidden parent traversal (..): ${arg}`);
    }
    if (/(?:^|[\\/])(?:\.git|\.forge)(?:[\\/]|$)/.test(arg) || trimmedArg === ".git" || trimmedArg === ".forge") {
      throw commandError("COMMAND_PROTECTED_PATH", `Argument references protected directory (.git or .forge): ${arg}`);
    }
    if (isAbsolute(arg)) {
      resolveProjectContainedPath(projectRoot, arg, { forbidProtected: true, label: "argument" });
    }
  }
  const hasInlineFlag = args.some((token) => INLINE_EVAL_FLAGS.has(token) || token.startsWith("--eval=") || token.startsWith("--print=") || token.startsWith("--require=") || token.startsWith("--import="));
  if ((command === "node" || command === "php") && hasInlineFlag) {
    for (const arg of args) {
      if (arg.includes(".git") || arg.includes(".forge")) {
        throw commandError("COMMAND_PROTECTED_PATH", `Inline ${command} evaluation may not target .git or .forge.`);
      }
      if (INLINE_EXEC_PATTERNS.test(arg)) {
        throw commandError("COMMAND_INLINE_PROCESS_FORBIDDEN", `Inline ${command} evaluation may not invoke child processes or git.`);
      }
    }
    return;
  }
  if (command === "pnpm") {
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      if (FORBIDDEN_PNPM_SUBCOMMANDS.has(token)) throw commandError("COMMAND_FLAG_FORBIDDEN", `pnpm subcommand '${token}' is forbidden.`);
      if (token === "-g" || token === "--global" || token.startsWith("--global=")) throw commandError("COMMAND_FLAG_FORBIDDEN", "pnpm global operations (--global / -g) are forbidden.");
      if (token === "--dir" || token === "-C") {
        if (!args[i + 1]) throw commandError("COMMAND_ARGS_INVALID", `pnpm ${token} requires a directory argument.`);
        resolveProjectContainedPath(projectRoot, resolve(cwdAbsolute, args[i + 1]), { forbidProtected: true, label: "pnpm --dir" });
      }
    }
    return;
  }
  if (command === "npm") {
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      if (FORBIDDEN_NPM_SUBCOMMANDS.has(token)) throw commandError("COMMAND_FLAG_FORBIDDEN", `npm subcommand '${token}' is forbidden.`);
      if (token === "-g" || token === "--global" || token === "--location=global") throw commandError("COMMAND_FLAG_FORBIDDEN", "npm global operations (-g / --global) are forbidden.");
      if (token === "--prefix") {
        if (!args[i + 1]) throw commandError("COMMAND_ARGS_INVALID", "npm --prefix requires a directory argument.");
        resolveProjectContainedPath(projectRoot, resolve(cwdAbsolute, args[i + 1]), { forbidProtected: true, label: "npm --prefix" });
      }
    }
    return;
  }
  if (command === "npx") {
    for (const token of args) {
      if (token === "-c" || token === "--call" || token === "--yes" || token === "-y" || token.startsWith("--package") || /^https?:\/\//i.test(token) || /^git\+/i.test(token)) {
        throw commandError("COMMAND_FLAG_FORBIDDEN", `npx flag or remote package '${token}' is forbidden; only local project binaries are permitted.`);
      }
    }
    const firstNonFlag = args.find((token) => !token.startsWith("-"));
    if (!firstNonFlag || (!SAFE_NPX_BINARIES.has(firstNonFlag) && !/^[A-Za-z0-9._-]+$/.test(firstNonFlag))) {
      throw commandError("COMMAND_FLAG_FORBIDDEN", `npx binary '${firstNonFlag ?? "<missing>"}' is not a valid local CLI name.`);
    }
    return;
  }
  if (command === "php") {
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      if (token === "-S" || token.startsWith("-S")) throw commandError("COMMAND_FLAG_FORBIDDEN", "php built-in web server (-S) is forbidden.");
      if (token === "-c") {
        if (!args[i + 1]) throw commandError("COMMAND_ARGS_INVALID", "php -c requires a configuration path inside projectRoot.");
        resolveProjectContainedPath(projectRoot, resolve(cwdAbsolute, args[i + 1]), { forbidProtected: true, label: "php -c" });
      }
    }
  }
}

// Business purpose: Validates zip and unzip archive paths and entries so archives cannot read/write outside projectRoot or perform Zip Slip attacks.
// Technical description: Resolves archive and target paths inside projectRoot, checks symlinks, and inspects zip entries using the caller's remaining deadline and AbortSignal.
export async function validateArchiveOperation(command, args, cwdAbsolute, projectRoot, runProcess, { remainingTimeoutMs, signal } = {}) {
  if (command === "zip") {
    const pathArgs = args.filter((arg) => !arg.startsWith("-"));
    if (pathArgs.length < 2) throw commandError("COMMAND_ARCHIVE_INVALID", "zip requires an output archive path and at least one input path inside projectRoot.");
    for (const rawTarget of pathArgs) {
      const resolved = resolveProjectContainedPath(projectRoot, resolve(cwdAbsolute, rawTarget), { forbidProtected: true, label: "zip path" });
      await assertNoSymlinkEscape(projectRoot, resolved.absolutePath);
    }
    return;
  }
  if (command === "unzip") {
    const isListOnly = args.includes("-l") || args.includes("-Z") || args.includes("-Z1");
    let archiveArg = null;
    let targetDirAbs = cwdAbsolute;
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      if (token === "-d") {
        if (!args[i + 1]) throw commandError("COMMAND_ARCHIVE_INVALID", "unzip -d requires a target directory inside projectRoot.");
        targetDirAbs = resolveProjectContainedPath(projectRoot, resolve(cwdAbsolute, args[i + 1]), { forbidProtected: true, label: "unzip target_dir" }).absolutePath;
        i += 1;
      } else if (!token.startsWith("-") && !archiveArg) {
        archiveArg = token;
      }
    }
    if (!archiveArg) throw commandError("COMMAND_ARCHIVE_INVALID", "unzip requires an archive file path inside projectRoot.");
    const resolvedArchive = resolveProjectContainedPath(projectRoot, resolve(cwdAbsolute, archiveArg), { forbidProtected: true, label: "unzip archive" });
    await assertNoSymlinkEscape(projectRoot, resolvedArchive.absolutePath);
    await assertNoSymlinkEscape(projectRoot, targetDirAbs);
    if (!isListOnly) {
      const preflightTimeout = () => {
        const left = typeof remainingTimeoutMs === "function" ? remainingTimeoutMs() : (remainingTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
        if (left <= 0) throw commandError("COMMAND_TIMEOUT", "Command exceeded timeout before archive inspection completed.");
        return Math.min(left, 15_000);
      };
      const listRes = await runProcess("unzip", ["-Z1", resolvedArchive.absolutePath], { cwd: cwdAbsolute, timeoutMs: preflightTimeout(), signal });
      if (listRes.exitCode !== 0) throw commandError("COMMAND_ARCHIVE_INVALID", `Failed to inspect archive entries before extraction: ${listRes.stderr || "invalid zip archive"}`);
      const entries = listRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const entryName of entries) {
        if (isAbsolute(entryName) || entryName.startsWith("/") || entryName.startsWith("\\")) {
          throw commandError("COMMAND_ZIP_SLIP_FORBIDDEN", `Zip Slip detected: archive entry has absolute path '${entryName}'.`);
        }
        const normalizedEntry = normalize(entryName).replace(/\\/g, "/");
        if (normalizedEntry === ".." || normalizedEntry.startsWith("../") || normalizedEntry.includes("/../") || isProtectedInternalSegment(normalizedEntry)) {
          throw commandError("COMMAND_ZIP_SLIP_FORBIDDEN", `Zip Slip or protected path detected in archive entry '${entryName}'.`);
        }
        const destAbs = resolve(targetDirAbs, entryName);
        resolveProjectContainedPath(projectRoot, destAbs, { forbidProtected: true, label: "archive entry" });
        await assertNoSymlinkEscape(projectRoot, destAbs);
      }
      const verboseRes = await runProcess("unzip", ["-Z", "-l", resolvedArchive.absolutePath], { cwd: cwdAbsolute, timeoutMs: preflightTimeout(), signal });
      if (verboseRes.exitCode === 0 && /^l[rwx-]{9}/m.test(verboseRes.stdout)) {
        throw commandError("COMMAND_ZIP_SLIP_FORBIDDEN", "Archive contains symbolic link entries, which are forbidden during unzip extraction.");
      }
    }
  }
}
