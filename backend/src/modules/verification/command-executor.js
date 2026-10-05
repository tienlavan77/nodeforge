import { spawn } from "node:child_process";

import { ConfigurationError } from "../../shared/errors.js";

export function createProjectCommandExecutor({ projectRoot, spawnProcess = spawn } = {}) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0 || typeof spawnProcess !== "function") {
    throw new ConfigurationError("A project root and spawn function are required for verification commands.");
  }

  return (command, { timeoutMs, signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { resolve({ exitCode: null, signal: null, timedOut: false, cancelled: true, stdout: "", stderr: "" }); return; }
    const environment = { ...process.env };
    // Node's test-worker marker would make a child `node --test` skip project tests.
    delete environment.NODE_TEST_CONTEXT;
    // Keep shell tools such as ESLint from resolving diagnostics against Forge's own cwd.
    environment.PWD = projectRoot;
    const child = spawnProcess(command, { cwd: projectRoot, env: environment, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    if (!child?.stdout || !child?.stderr) {
      reject(new ConfigurationError("Verification commands must expose stdout and stderr streams."));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let stopFailure;
    const stop = (reason) => {
      if (settled) return;
      cancelled ||= reason === "cancelled";
      timedOut ||= reason === "timeout";
      try { if (process.platform !== "win32" && Number.isInteger(child.pid)) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") stopFailure = error; }
      forceStopTimer = setTimeout(() => {
        try { if (process.platform !== "win32" && Number.isInteger(child.pid)) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") stopFailure = error; }
      }, 2000);
      forceStopTimer.unref?.();
    };
    let forceStopTimer;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => stop("timeout"), timeoutMs) : undefined;
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { settled = true; if (timer) clearTimeout(timer); if (forceStopTimer) clearTimeout(forceStopTimer); signal?.removeEventListener("abort", onAbort); reject(error); });
    // `close` runs only after stdout and stderr close, so diagnostic output is complete.
    child.once("close", (exitCode, processSignal) => { settled = true; if (timer) clearTimeout(timer); if (forceStopTimer) clearTimeout(forceStopTimer); signal?.removeEventListener("abort", onAbort); resolve({ exitCode: timedOut || cancelled ? null : exitCode, signal: processSignal, timedOut, cancelled, stdout, stderr: [stderr, stopFailure ? `Process stop failed: ${stopFailure.message}` : ""].filter(Boolean).join("\n") }); });
  });
}
