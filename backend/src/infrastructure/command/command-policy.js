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
const INLINE_FS_ESCAPE_PATTERNS = /\b(file_put_contents|file_get_contents|fopen|readfile|unlink|rename|copy|mkdir|rmdir|scandir|glob|chmod|chown|symlink|link|touch|move_uploaded_file|writeFileSync|writeFile|readFileSync|readFile|appendFileSync|appendFile|unlinkSync|rmSync|rmdirSync|mkdirSync|renameSync|copyFileSync|chmodSync|chownSync|symlinkSync|linkSync|openSync|createWriteStream|createReadStream)\b|(?:^|['"`\s=(])\/(?:tmp|etc|var|usr|bin|sbin|opt|root|home|proc|sys|dev)(?:\/|['"`\s)]|$)/i;
const PHP_DISABLED_FUNCTIONS = "exec,passthru,shell_exec,system,proc_open,popen,pcntl_exec,pcntl_fork,dl,mail,putenv,apache_setenv,posix_kill,posix_mkfifo,posix_setpgid,posix_setsid,posix_setuid,symlink,link,chgrp,chown,lchgrp,lchown";

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
  let rootReal;
  try {
    rootReal = await realpath(projectRoot);
  } catch (error) {
    throw commandError("COMMAND_FILESYSTEM_ERROR", `Failed to resolve projectRoot realpath '${projectRoot}': ${error.message}`);
  }
  const rel = relative(resolve(projectRoot), targetAbsPath).split(sep).filter(Boolean);
  let current = resolve(projectRoot);
  for (const part of rel) {
    current = resolve(current, part);
    let stat = null;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw commandError("COMMAND_FILESYSTEM_ERROR", `Failed to inspect path segment '${part}': ${error.message}`);
    }
    if (stat.isSymbolicLink()) {
      let targetReal = null;
      try {
        targetReal = await realpath(current);
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw commandError("COMMAND_SYMLINK_ESCAPE", `Broken symlink encountered: ${part}`);
        }
        throw commandError("COMMAND_FILESYSTEM_ERROR", `Failed to resolve symlink '${part}': ${error.message}`);
      }
      const relReal = relative(rootReal, targetReal).split(sep).join("/");
      if (relReal.startsWith("..") || isAbsolute(relReal) || isProtectedInternalSegment(relReal)) {
        throw commandError("COMMAND_SYMLINK_ESCAPE", `Symlink escapes projectRoot or points into protected directory: ${part}`);
      }
    }
  }
}

// Business purpose: Builds runtime sandbox arguments for inline node and php evaluations so filesystem access stays confined to projectRoot.
// Technical description: Injects PHP open_basedir and disable_functions INI flags for php -r and Node permission flags (--permission, --allow-fs-read, --allow-fs-write) for node -e/-p when supported by the runtime.
export function buildSandboxedInlineArgs(command, args, projectRoot) {
  const rootAbs = resolve(projectRoot);
  const hasInlineFlag = args.some((token) => INLINE_EVAL_FLAGS.has(token) || token.startsWith("--eval=") || token.startsWith("--print=") || token.startsWith("--require=") || token.startsWith("--import="));
  if (!hasInlineFlag) return [...args];
  if (command === "php") return ["-d", `open_basedir=${rootAbs}`, "-d", `disable_functions=${PHP_DISABLED_FUNCTIONS}`, ...args];
  if (command === "node") {
    const permFlag = Number.parseInt(process.versions.node.split(".")[0], 10) >= 22 ? "--permission" : "--experimental-permission";
    return [permFlag, `--allow-fs-read=${rootAbs}*`, `--allow-fs-write=${rootAbs}*`, ...args];
  }
  return [...args];
}

// Business purpose: Validates that every non-flag argument or path-valued flag resolves inside projectRoot without traversing symlinks outside projectRoot.
// Technical description: Inspects non-flag arguments and flag-assigned path values, resolves them against cwdAbsolute and projectRoot, and calls assertNoSymlinkEscape on each candidate path.
export async function assertCommandArgSymlinkSafety(projectRoot, cwdAbsolute, command, args) {
  const inlineEval = (command === "node" || command === "php") && args.some((t) => INLINE_EVAL_FLAGS.has(t));
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i];
    if (inlineEval && i > 0 && INLINE_EVAL_FLAGS.has(args[i - 1])) continue;
    if (raw.startsWith("--eval=") || raw.startsWith("--print=") || raw.startsWith("--require=") || raw.startsWith("--import=")) continue;
    const candidate = raw.startsWith("-") ? (raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : "") : raw;
    if (!candidate || /^https?:\/\//i.test(candidate)) continue;
    if (isAbsolute(candidate) || (raw.startsWith("-") && (candidate.includes("/") || candidate.includes("\\")))) {
      const resolved = resolveProjectContainedPath(projectRoot, isAbsolute(candidate) ? candidate : resolve(cwdAbsolute, candidate), { forbidProtected: true, label: "option argument" });
      await assertNoSymlinkEscape(projectRoot, resolved.absolutePath);
      continue;
    }
    const targetAbs = resolve(cwdAbsolute, candidate);
    const rel = relative(resolve(projectRoot), targetAbs).split(sep).join("/");
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      await assertNoSymlinkEscape(projectRoot, targetAbs);
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
    const isInlineCodeOption = arg.startsWith("--eval=") || arg.startsWith("--print=") || arg.startsWith("--require=") || arg.startsWith("--import=");
    const optionValue = arg.startsWith("-") && arg.includes("=") && !isInlineCodeOption ? arg.slice(arg.indexOf("=") + 1) : "";
    if (isAbsolute(arg)) {
      resolveProjectContainedPath(projectRoot, arg, { forbidProtected: true, label: "argument" });
    } else if (!arg.startsWith("-") && (arg.includes("/") || arg.includes("\\"))) {
      resolveProjectContainedPath(projectRoot, resolve(cwdAbsolute, arg), { forbidProtected: true, label: "argument" });
    } else if (optionValue && !/^https?:\/\//i.test(optionValue) && (isAbsolute(optionValue) || optionValue.includes("/") || optionValue.includes("\\") || optionValue.includes(".."))) {
      resolveProjectContainedPath(projectRoot, isAbsolute(optionValue) ? optionValue : resolve(cwdAbsolute, optionValue), { forbidProtected: true, label: "option argument" });
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
      const literalMatches = [...arg.matchAll(/(['"`])((?:\\.|(?!\1).)+)\1/g)];
      for (const match of literalMatches) {
        const literal = match[2];
        if (literal.includes("..")) {
          throw commandError("COMMAND_PATH_OUTSIDE_PROJECT", `Inline ${command} evaluation may not contain parent traversal (..): ${literal}`);
        }
        if (literal.startsWith("/") && !/^\/\//.test(literal)) {
          resolveProjectContainedPath(projectRoot, literal, { forbidProtected: true, label: "inline path literal" });
        }
      }
      if (INLINE_FS_ESCAPE_PATTERNS.test(arg) && (/['"`]\s*\/[A-Za-z0-9._-]|\bchr\s*\(|\bbase64_decode\s*\(|\bhex2bin\s*\(|\bBuffer\.from\s*\(|\bString\.fromCharCode\s*\(/i.test(arg))) {
        throw commandError("COMMAND_PATH_OUTSIDE_PROJECT", `Inline ${command} evaluation attempts unsafe filesystem access outside projectRoot.`);
      }
    }
    return;
  }
  if (command === "pnpm") {
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      if (FORBIDDEN_PNPM_SUBCOMMANDS.has(token)) throw commandError("COMMAND_FLAG_FORBIDDEN", `pnpm subcommand '${token}' is forbidden.`);
      if (token === "-g" || token === "--global" || token.startsWith("--global=")) throw commandError("COMMAND_FLAG_FORBIDDEN", "pnpm global operations (--global / -g) are forbidden.");
      if (token === "--dir" || token === "-C" || token.startsWith("--dir=") || token.startsWith("-C=")) {
        const dirVal = token.includes("=") ? token.slice(token.indexOf("=") + 1) : args[i + 1];
        if (!dirVal) throw commandError("COMMAND_ARGS_INVALID", `pnpm ${token} requires a directory argument.`);
        resolveProjectContainedPath(projectRoot, isAbsolute(dirVal) ? dirVal : resolve(cwdAbsolute, dirVal), { forbidProtected: true, label: "pnpm --dir" });
      }
    }
    return;
  }
  if (command === "npm") {
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      if (FORBIDDEN_NPM_SUBCOMMANDS.has(token)) throw commandError("COMMAND_FLAG_FORBIDDEN", `npm subcommand '${token}' is forbidden.`);
      if (token === "-g" || token === "--global" || token === "--location=global") throw commandError("COMMAND_FLAG_FORBIDDEN", "npm global operations (-g / --global) are forbidden.");
      if (token === "--prefix" || token.startsWith("--prefix=")) {
        const prefixVal = token.includes("=") ? token.slice(token.indexOf("=") + 1) : args[i + 1];
        if (!prefixVal) throw commandError("COMMAND_ARGS_INVALID", "npm --prefix requires a directory argument.");
        resolveProjectContainedPath(projectRoot, isAbsolute(prefixVal) ? prefixVal : resolve(cwdAbsolute, prefixVal), { forbidProtected: true, label: "npm --prefix" });
      }
    }
    return;
  }
  if (command === "npx") {
    for (const token of args) {
      if (token === "-c" || token.startsWith("-c=") || token === "--call" || token.startsWith("--call=") || token === "--yes" || token === "-y" || token.startsWith("--package") || /^https?:\/\//i.test(token) || /^git\+/i.test(token)) {
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
      if (token === "-c" || token.startsWith("-c")) {
        const cfgVal = token === "-c" ? args[i + 1] : (token.startsWith("-c=") ? token.slice(3) : token.slice(2));
        if (!cfgVal) throw commandError("COMMAND_ARGS_INVALID", "php -c requires a configuration path inside projectRoot.");
        resolveProjectContainedPath(projectRoot, isAbsolute(cfgVal) ? cfgVal : resolve(cwdAbsolute, cfgVal), { forbidProtected: true, label: "php -c" });
      }
    }
  }
}
