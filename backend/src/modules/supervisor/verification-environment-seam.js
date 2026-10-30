// Business purpose: standardizes the multi-project Execution Environment Seam so all verification commands (project write sandbox, filesystem_namespace, and browser_fixture) route through one project-scoped adapter contract with strict path containment and deterministic lifecycle cleanup.
// Technical description: exports DEFAULT_DEPENDENCY_ROOTS, resolveProjectDependencyRoots, assertVerificationExecutionScope, executeWithVerificationEnvironmentSeam, and closeVerificationEnvironmentSeam for ticket and reviewer verification services.
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";
import { filesystemVerificationCommand } from "./filesystem-verification-command.js";
import { closeFilesystemNamespaceRunner, runFilesystemNamespace } from "./filesystem-namespace-runner.js";
import { runOrdinaryVerificationSandbox } from "./ordinary-verification-sandbox.js";
import { assertVerificationRunnerEnvironment } from "./verification-runner-environment.js";

export const DEFAULT_DEPENDENCY_ROOTS = Object.freeze([
  "node_modules",
  "backend/node_modules",
  "ui/nextjs/node_modules"
]);

// Business purpose: provides a single source of truth for dependency directories linked into verification archives and worktrees across NodeForge and target projects.
// Technical description: returns the immutable list of relative node_modules paths for the given project root.
export function resolveProjectDependencyRoots(projectRoot) {
  void projectRoot;
  return DEFAULT_DEPENDENCY_ROOTS;
}

// Business purpose: constructs a typed ConfigurationError with an attached error code for verification seam violations.
// Technical description: attaches the error code to a ConfigurationError instance.
function seamError(code, message, cause) {
  return Object.assign(new ConfigurationError(message, cause ? { cause } : undefined), { code });
}

// Business purpose: checks whether childPath is equal to or strictly inside parentDir after canonical resolution.
// Technical description: computes path.relative(parentDir, childPath) and rejects '..' or absolute escapes.
function isContainedPath(parentDir, childPath) {
  if (childPath === parentDir) return true;
  const rel = relative(parentDir, childPath);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Business purpose: enforces multi-project path containment before any verification subprocess or sandbox can launch so Project A can never execute inside or write to Project B's directories.
// Technical description: resolves canonical realpaths for projectRoot, cwd, and optional tempDir, verifying that cwd and tempDir reside within canonicalProjectRoot and never point to the root .forge directory or global project catalog.
export async function assertVerificationExecutionScope({ projectRoot, cwd, tempDir } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot.trim() || typeof cwd !== "string" || !cwd.trim()) {
    throw seamError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", "Verification execution scope requires both projectRoot and cwd.");
  }
  let canonicalProjectRoot;
  let canonicalCwd;
  try {
    canonicalProjectRoot = await realpath(projectRoot);
    canonicalCwd = await realpath(cwd);
  } catch (error) {
    throw seamError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", `Verification scope path does not exist: ${error.message}`, error);
  }
  if (!isContainedPath(canonicalProjectRoot, canonicalCwd)) {
    throw seamError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", `Verification cwd '${canonicalCwd}' is outside project root '${canonicalProjectRoot}'.`);
  }
  let canonicalTempDir = null;
  if (tempDir !== undefined && tempDir !== null) {
    if (typeof tempDir !== "string" || !tempDir.trim()) {
      throw seamError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", "Verification tempDir must be a non-empty path when provided.");
    }
    try {
      const statInfo = await lstat(tempDir);
      if (statInfo.isSymbolicLink()) {
        throw seamError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", "Verification tempDir must not be a symbolic link.");
      }
      canonicalTempDir = await realpath(tempDir);
    } catch (error) {
      if (error.code === "VERIFY_ENVIRONMENT_SCOPE_VIOLATION") throw error;
      throw seamError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", `Verification tempDir cannot be resolved: ${error.message}`, error);
    }
    if (!isContainedPath(canonicalProjectRoot, canonicalTempDir)) {
      throw seamError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", `Verification tempDir '${canonicalTempDir}' escapes project root '${canonicalProjectRoot}'.`);
    }
    if (canonicalTempDir === join(canonicalProjectRoot, ".forge")) {
      throw seamError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", "Verification tempDir cannot be the root .forge directory.");
    }
    const catalogPath = process.env.NODEFORGE_PROJECT_CATALOG_PATH;
    if (typeof catalogPath === "string" && catalogPath.trim() && resolve(catalogPath) === canonicalTempDir) {
      throw seamError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", "Verification tempDir cannot target the global project catalog.");
    }
  }
  return { canonicalProjectRoot, canonicalCwd, canonicalTempDir };
}

// Business purpose: routes a validated verification command to the appropriate environment adapter (filesystem_namespace, browser_fixture, or project_sandbox) with fail-closed scope enforcement.
// Technical description: validates the requested environment enum, verifies canonical path containment when projectRoot is provided, and dispatches execution to the selected adapter without cross-adapter fallback.
export async function executeWithVerificationEnvironmentSeam({
  argv,
  cwd,
  tempDir,
  outputDirs = [],
  timeoutMs = 120000,
  signal,
  environment,
  projectRoot,
  onOutput,
  sandbox = false,
  bwrapPath,
  spawnImpl
} = {}) {
  assertVerificationRunnerEnvironment(environment);
  signal?.throwIfAborted();

  if (environment === "filesystem_namespace") {
    if (!projectRoot) throw new Error("Filesystem verification requires its Node-bound project root.");
    const { canonicalProjectRoot, canonicalCwd } = await assertVerificationExecutionScope({ projectRoot, cwd, tempDir });
    const command = argv[0] === "node" ? [process.execPath, ...argv.slice(1)] : argv;
    if (command[0] !== process.execPath) {
      throw seamError("VERIFY_ENVIRONMENT_INVALID", "Filesystem namespace verification requires a Node command.");
    }
    return runFilesystemNamespace({ projectRoot: canonicalProjectRoot, argv: command, cwd: canonicalCwd, timeoutMs, signal, onOutput });
  }

  const effectiveProjectRoot = projectRoot ?? cwd;
  const { canonicalProjectRoot, canonicalCwd, canonicalTempDir } = effectiveProjectRoot
    ? await assertVerificationExecutionScope({ projectRoot: effectiveProjectRoot, cwd, tempDir })
    : { canonicalProjectRoot: null, canonicalCwd: cwd, canonicalTempDir: tempDir ?? null };

  const isBrowserFixture = Array.isArray(argv) && argv.some((arg) => typeof arg === "string" && arg.includes("verify-ticket-browser.mjs"));
  if (isBrowserFixture) {
    const result = await spawnScopedProcess({ argv, cwd: canonicalCwd, tempDir: canonicalTempDir, timeoutMs, signal, onOutput, spawnImpl });
    return {
      ...result,
      runtime_environment: { type: "browser_fixture", project_root: canonicalProjectRoot }
    };
  }

  const useBubblewrapSandbox = sandbox === true || process.env.NODEFORGE_ORDINARY_VERIFICATION_SANDBOX === "1" || Boolean(bwrapPath);
  if (useBubblewrapSandbox) {
    return runOrdinaryVerificationSandbox({
      projectRoot: canonicalProjectRoot,
      cwd: canonicalCwd,
      tempDir: canonicalTempDir,
      outputDirs,
      argv,
      timeoutMs,
      signal,
      onOutput,
      bwrapPath,
      spawnImpl
    });
  }

  const env = { ...process.env, PWD: canonicalCwd, ...(canonicalTempDir ? { TMPDIR: canonicalTempDir, TMP: canonicalTempDir, TEMP: canonicalTempDir } : {}) };
  delete env.NODE_TEST_CONTEXT;
  const launch = environment === "project" ? argv : filesystemVerificationCommand(argv, canonicalCwd, env);
  const result = await spawnScopedProcess({ argv: launch, cwd: canonicalCwd, tempDir: canonicalTempDir, timeoutMs, signal, onOutput, env, spawnImpl });
  return {
    ...result,
    runtime_environment: { type: "project_sandbox", project_root: canonicalProjectRoot }
  };
}

// Business purpose: executes a scoped verification child process with sanitized environment variables, bounded timeout, and output streaming.
// Technical description: spawns argv[0] without a shell, pipes stdout/stderr to onOutput, and resolves exit_code (or null on timeout).
function spawnScopedProcess({ argv, cwd, tempDir, timeoutMs, signal, onOutput, env: suppliedEnv, spawnImpl = spawn }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const env = suppliedEnv ?? { ...process.env, PWD: cwd, ...(tempDir ? { TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir } : {}) };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnImpl(argv[0], argv.slice(1), { cwd, env, signal, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => onOutput?.("stdout", chunk));
    child.stderr.on("data", (chunk) => onOutput?.("stderr", chunk));
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("close", (code) => { clearTimeout(timer); resolvePromise({ exit_code: timedOut ? null : code }); });
  });
}

// Business purpose: releases all verification environment runners and sockets bound to a project root when the project is closed or removed.
// Technical description: invokes closeFilesystemNamespaceRunner for the target project root.
export async function closeVerificationEnvironmentSeam(projectRoot) {
  await closeFilesystemNamespaceRunner(projectRoot);
}
