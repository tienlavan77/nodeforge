// Business purpose: enforces an OS-level, per-command Bubblewrap write sandbox for ordinary ticket verification so tests, linters, and typechecks cannot read or mutate sibling projects, the global project catalog, host credentials, or the project's own source and .forge state tree.
// Technical description: validates canonical project/archive/temp/output paths, constructs a fail-closed Bubblewrap mount namespace with read-only source and dependency bindings, masks .forge and sibling project roots, restricts writes to job-scoped temp/runtime/output directories, and tears down descendant processes on exit, timeout, or abort without falling back to unsandboxed host spawn.
import { spawn, spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";

const SYSTEM_RO_PATHS = Object.freeze(["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"]);
const SAFE_ENV_KEYS = Object.freeze(["PATH", "LANG", "LC_ALL", "NODE_ENV", "NODE_OPTIONS", "NO_COLOR", "FORCE_COLOR", "TZ"]);

// Business purpose: creates a typed ConfigurationError with an explicit infrastructure/scope error code for fail-closed sandbox rejections.
// Technical description: attaches the error code and optional cause to a ConfigurationError instance.
const sandboxError = (code, message, cause) => Object.assign(new ConfigurationError(message, cause ? { cause } : undefined), { code });

// Business purpose: verifies that a target path stays strictly inside a canonical parent directory without traversing symlinks or parent segments.
// Technical description: checks path.relative containment between two canonical absolute paths.
function isInsideCanonical(parentDir, childPath) {
  if (childPath === parentDir) return true;
  const rel = relative(parentDir, childPath);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Business purpose: validates and canonicalizes all sandbox paths and constructs the exact Bubblewrap argument vector for a single ordinary verification command.
// Technical description: checks the Bubblewrap binary, resolves canonical projectRoot, cwd, tempDir, and outputDirs, masks sibling roots, HOME, global catalog, and .forge, and mounts only tempDir, archive-local .forge/runtime, and declared outputDirs as writable.
export async function buildOrdinaryVerificationSandboxPlan({
  projectRoot, cwd, tempDir, outputDirs = [], argv = [],
  bwrapPath = process.env.NODEFORGE_BWRAP_PATH || "/usr/bin/bwrap", env = process.env
} = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== "string" || !arg.length || arg.includes("\0"))) {
    throw sandboxError("VERIFY_ENVIRONMENT_INVALID", "Verification sandbox requires a non-empty string argument vector.");
  }
  if (typeof projectRoot !== "string" || !projectRoot.trim() || typeof cwd !== "string" || !cwd.trim()) {
    throw sandboxError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", "Verification sandbox requires explicit projectRoot and cwd.");
  }
  try { await access(bwrapPath, constants.X_OK); }
  catch (error) { throw sandboxError("VERIFY_SANDBOX_UNAVAILABLE", `Bubblewrap binary is unavailable or not executable at ${bwrapPath}.`, error); }

  let canonicalProjectRoot; let canonicalCwd;
  try { canonicalProjectRoot = await realpath(projectRoot); canonicalCwd = await realpath(cwd); }
  catch (error) { throw sandboxError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", `Verification sandbox path cannot be resolved: ${error.message}`, error); }
  if (!isInsideCanonical(canonicalProjectRoot, canonicalCwd)) {
    throw sandboxError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", "Verification cwd escapes the canonical project root.");
  }

  const effectiveTempInput = tempDir || join(canonicalCwd, ".forge-tmp");
  await mkdir(effectiveTempInput, { recursive: true });
  if ((await lstat(effectiveTempInput)).isSymbolicLink()) {
    throw sandboxError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", "Verification tempDir must not be a symbolic link.");
  }
  const canonicalTempDir = await realpath(effectiveTempInput);
  const projectForgeDir = join(canonicalProjectRoot, ".forge");
  if (!isInsideCanonical(canonicalProjectRoot, canonicalTempDir) || canonicalTempDir === projectForgeDir) {
    throw sandboxError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", "Verification tempDir escapes the canonical project root or targets .forge.");
  }

  const canonicalOutputs = [];
  for (const rawOut of outputDirs) {
    if (typeof rawOut !== "string" || !rawOut.trim() || rawOut.includes("\0")) throw sandboxError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", "Verification output directory path is invalid.");
    const candidate = isAbsolute(rawOut) ? resolve(rawOut) : resolve(canonicalCwd, rawOut);
    await mkdir(candidate, { recursive: true });
    if ((await lstat(candidate)).isSymbolicLink()) throw sandboxError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", "Verification output directory must not be a symbolic link.");
    const resolvedOut = await realpath(candidate);
    if (!isInsideCanonical(canonicalCwd, resolvedOut)) throw sandboxError("VERIFY_ENVIRONMENT_SCOPE_VIOLATION", "Verification output directory must stay inside the job archive cwd.");
    canonicalOutputs.push(resolvedOut);
  }

  const archiveRuntimeDir = canonicalCwd !== canonicalProjectRoot ? join(canonicalCwd, ".forge/runtime") : null;
  if (archiveRuntimeDir) await mkdir(archiveRuntimeDir, { recursive: true });

  const args = ["--die-with-parent", "--new-session"];
  for (const sysPath of SYSTEM_RO_PATHS) if (existsSync(sysPath)) args.push("--ro-bind", sysPath, sysPath);
  const nodeDir = dirname(process.execPath);
  if (existsSync(nodeDir) && !SYSTEM_RO_PATHS.some((sys) => isInsideCanonical(sys, nodeDir))) args.push("--ro-bind", nodeDir, nodeDir);
  args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");

  const parentOfProject = dirname(canonicalProjectRoot);
  if (parentOfProject && parentOfProject !== "/" && !SYSTEM_RO_PATHS.includes(parentOfProject)) args.push("--tmpfs", parentOfProject);
  if (typeof env.HOME === "string" && env.HOME.startsWith("/") && env.HOME !== "/" && !isInsideCanonical(env.HOME, canonicalProjectRoot) && existsSync(env.HOME)) {
    args.push("--tmpfs", env.HOME);
  }
  if (typeof env.NODEFORGE_PROJECT_CATALOG_PATH === "string" && env.NODEFORGE_PROJECT_CATALOG_PATH.startsWith("/")) {
    const catalogDir = dirname(resolve(env.NODEFORGE_PROJECT_CATALOG_PATH));
    if (catalogDir !== "/" && !isInsideCanonical(catalogDir, canonicalProjectRoot) && existsSync(catalogDir)) args.push("--tmpfs", catalogDir);
  }

  args.push("--ro-bind", canonicalProjectRoot, canonicalProjectRoot);
  if (existsSync(projectForgeDir)) args.push("--tmpfs", projectForgeDir);
  if (canonicalCwd !== canonicalProjectRoot) args.push("--ro-bind", canonicalCwd, canonicalCwd);
  args.push("--bind", canonicalTempDir, canonicalTempDir, "--bind", canonicalTempDir, "/tmp");
  if (archiveRuntimeDir && existsSync(archiveRuntimeDir)) args.push("--bind", archiveRuntimeDir, archiveRuntimeDir);
  for (const outDir of canonicalOutputs) args.push("--bind", outDir, outDir);

  args.push("--chdir", canonicalCwd, "--clearenv");
  for (const key of SAFE_ENV_KEYS) if (typeof env[key] === "string") args.push("--setenv", key, env[key]);
  args.push("--setenv", "PWD", canonicalCwd, "--setenv", "TMPDIR", canonicalTempDir, "--setenv", "TMP", canonicalTempDir, "--setenv", "TEMP", canonicalTempDir, "--setenv", "HOME", canonicalTempDir);

  return { bwrapPath, canonicalProjectRoot, canonicalCwd, canonicalTempDir, canonicalOutputs, args: [...args, "--", ...argv], baseArgs: args, argv: [...argv] };
}

// Business purpose: executes a single ordinary verification command inside its short-lived Bubblewrap write sandbox and returns the exit code and runtime environment receipt.
// Technical description: builds the validated sandbox plan, launches Bubblewrap with user/mount namespace isolation (supporting delegated newuidmap handshake when required by host AppArmor), enforces timeout and abort teardown, and fails closed on any setup or spawn error.
export async function runOrdinaryVerificationSandbox({
  projectRoot, cwd, tempDir, outputDirs = [], argv = [], timeoutMs = 120000, signal, onOutput, bwrapPath, spawnImpl = spawn
} = {}) {
  signal?.throwIfAborted();
  const plan = await buildOrdinaryVerificationSandboxPlan({ projectRoot, cwd, tempDir, outputDirs, argv, bwrapPath });
  signal?.throwIfAborted();
  const useDelegatedMap = spawnImpl === spawn && shouldUseDelegatedUidMap(plan.bwrapPath);
  const finalArgs = useDelegatedMap
    ? ["--unshare-user", "--uid", "0", "--gid", "0", "--userns-block-fd", "4", "--info-fd", "3", "--cap-drop", "ALL", ...plan.baseArgs, "--", ...plan.argv]
    : ["--unshare-all", "--cap-drop", "ALL", ...plan.baseArgs, "--", ...plan.argv];

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false; let timedOut = false; let stderrBuf = "";
    const stdio = useDelegatedMap ? ["ignore", "pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];
    let child;
    try { child = spawnImpl(plan.bwrapPath, finalArgs, { cwd: plan.canonicalCwd, stdio }); }
    catch (error) { rejectPromise(sandboxError("VERIFY_SANDBOX_UNAVAILABLE", `Failed to spawn Bubblewrap sandbox: ${error.message}`, error)); return; }

    // Business purpose: clears timeout and abort listeners once the sandbox process terminates.
    // Technical description: removes the abort event listener and clears the timeout timer.
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };

    // Business purpose: kills the sandbox process immediately when the caller's AbortSignal fires.
    // Technical description: sends SIGKILL to the Bubblewrap child and rejects with the abort reason.
    const onAbort = () => {
      if (settled) return;
      settled = true; cleanup();
      try { child.kill("SIGKILL"); } catch (killErr) { void killErr; }
      rejectPromise(signal.reason ?? sandboxError("VERIFY_SANDBOX_ABORTED", "Verification sandbox aborted."));
    };
    if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener("abort", onAbort, { once: true }); }

    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch (killErr) { void killErr; } }, timeoutMs)
      : null;

    if (useDelegatedMap) {
      completeDelegatedHandshake(child, (handshakeError) => {
        if (settled) return;
        settled = true; cleanup();
        try { child.kill("SIGKILL"); } catch (killErr) { void killErr; }
        rejectPromise(sandboxError("VERIFY_SANDBOX_FAILED", `Bubblewrap delegated UID mapping failed: ${handshakeError.message}`, handshakeError));
      });
    }
    child.stdout?.setEncoding?.("utf8"); child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => onOutput?.("stdout", chunk));
    child.stderr?.on?.("data", (chunk) => { stderrBuf = (stderrBuf + chunk).slice(-4096); onOutput?.("stderr", chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true; cleanup();
      const code = error.code === "ENOENT" || error.code === "EACCES" ? "VERIFY_SANDBOX_UNAVAILABLE" : "VERIFY_SANDBOX_FAILED";
      rejectPromise(sandboxError(code, `Bubblewrap execution failed: ${error.message}`, error));
    });
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      settled = true; cleanup();
      if (!timedOut && code !== 0 && /bwrap:|setting up uid map|Operation not permitted|Can't mount|Failed to mount/i.test(stderrBuf)) {
        rejectPromise(sandboxError("VERIFY_SANDBOX_FAILED", `Bubblewrap namespace setup failed: ${stderrBuf.trim().slice(0, 320)}`));
        return;
      }
      resolvePromise({
        exit_code: timedOut ? null : code, signal: exitSignal ?? null, timed_out: timedOut,
        runtime_environment: { type: "project_sandbox", engine: "bwrap", project_root: plan.canonicalProjectRoot, archive_cwd: plan.canonicalCwd, temp_dir: plan.canonicalTempDir }
      });
    });
  });
}

let cachedDelegatedMode = null;
// Business purpose: detects whether the host kernel requires delegated newuidmap/newgidmap helpers when Bubblewrap creates a user namespace.
// Technical description: probes bwrap --unshare-user true and returns true when direct unprivileged userns creation is blocked but subid helpers exist.
function shouldUseDelegatedUidMap(bwrapPath) {
  if (cachedDelegatedMode !== null) return cachedDelegatedMode;
  try {
    if (spawnSync(bwrapPath, ["--unshare-user", "--ro-bind", "/", "/", "--", "/bin/true"], { timeout: 2000 }).status === 0) {
      cachedDelegatedMode = false; return false;
    }
  } catch (probeErr) { void probeErr; }
  cachedDelegatedMode = existsSync("/usr/bin/getsubids") && existsSync("/usr/bin/newuidmap") && existsSync("/usr/bin/newgidmap");
  return cachedDelegatedMode;
}

// Business purpose: completes the Bubblewrap userns-block-fd handshake using the host's delegated subuid/subgid ranges.
// Technical description: reads child-pid from info-fd 3, invokes newuidmap and newgidmap, and writes '1' to block-fd 4.
function completeDelegatedHandshake(child, onError) {
  let info = "";
  child.stdio[3]?.on("error", onError); child.stdio[4]?.on("error", onError);
  child.stdio[3]?.on("data", (chunk) => { info += chunk; });
  child.stdio[3]?.once("end", () => {
    try {
      const pid = JSON.parse(info)["child-pid"];
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Missing Bubblewrap child PID.");
      const owner = process.env.USER || String(process.getuid());
      for (const [helper, flag, id] of [["/usr/bin/newuidmap", [], process.getuid()], ["/usr/bin/newgidmap", ["-g"], process.getgid()]]) {
        const sub = spawnSync("/usr/bin/getsubids", [...flag, owner], { encoding: "utf8", timeout: 3000 });
        const range = (sub.stdout || "").trim().split("\n").map((l) => l.trim().split(/\s+/)).find((f) => Number.isSafeInteger(Number(f[2])) && Number(f[2]) > 0 && Number(f[3]) >= 1000);
        if (sub.status !== 0 || !range) throw new Error(`No delegated subid range for ${helper}.`);
        const mapped = spawnSync(helper, [String(pid), "0", String(id), "1", "1", range[2], range[3]], { encoding: "utf8", timeout: 3000 });
        if (mapped.status !== 0) throw new Error(`${helper}: ${(mapped.stderr || "").trim()}`);
      }
      child.stdio[4]?.end("1");
    } catch (error) { onError(error); }
  });
}
