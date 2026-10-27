// Starts only the fixed namespace fixture service, never an agent-supplied
// provisioning command. Its private mounts and setup capabilities die with it.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, chmod, realpath, open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { namespaceProcess } from "../../../test-environments/filesystem/namespace-launch.mjs";
import { requestFilesystemNamespace } from "./filesystem-namespace-client.js";

// Provisions a bounded disposable session and waits for real socket readiness.
// Startup failures preserve a setup log while stopping only Node-owned children.
export async function startFilesystemNamespace({ projectRoot, signal, timeoutMs = 30000 }) {
  signal?.throwIfAborted();
  if (process.geteuid() !== 1000 || process.getegid() !== 1000) throw Object.assign(new Error("Filesystem namespace requires host UID/GID 1000."), { code: "VERIFY_RUNNER_UNAVAILABLE" });
  const scratch = join(projectRoot, ".forge/scratch");
  await mkdir(scratch, { recursive: true });
  if (await realpath(scratch) !== scratch) throw new Error("Filesystem runner scratch contains a symbolic link.");
  const control = await mkdtemp(join(scratch, "fs-ns-"));
  await chmod(control, 0o700);
  await mkdir(join(control, "fixtures"));
  const log = await open(join(control, "setup.log"), "a", 0o600);
  const launch = namespaceProcess([fileURLToPath(new URL("../../../test-environments/filesystem/namespace-server.mjs", import.meta.url)), control, projectRoot]);
  let child;
  try {
    child = spawn(launch.command, launch.argv, { env: { ...process.env, NODEFORGE_FILESYSTEM_PROJECT_ROOT: projectRoot },
      detached: true, stdio: ["ignore", log.fd, log.fd] });
  } finally { await log.close(); }
  let spawnError;
  let stopped = false;
  child.on("error", error => { spawnError = error; });
  child.unref();
  const stopOnExit = () => stopChild();
  process.once("exit", stopOnExit);
  child.once("close", () => { stopped = true; process.removeListener("exit", stopOnExit); });
  const abort = () => stopChild();
  signal?.addEventListener("abort", abort, { once: true });
  const socketPath = join(control, "runner.sock");
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Filesystem namespace setup exited; inspect ${control}/setup.log.`);
      try {
        const result = await requestFilesystemNamespace(socketPath, { action: "status" }, { signal, timeoutMs: 1000 });
        return { socketPath, identity: result.identity, stop: stopChild };
      } catch (error) { if (!["ENOENT", "ECONNREFUSED", "VERIFY_RUNNER_TIMEOUT"].includes(error.code)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Object.assign(new Error(`Filesystem namespace startup timed out; inspect ${control}/setup.log.`), { code: "VERIFY_RUNNER_UNAVAILABLE" });
  } catch (error) { stopChild(); throw error; }
  finally { signal?.removeEventListener("abort", abort); }

  // Terminates the owned process group and removes its exit hook; external
  // operator sessions are never handed to this cleanup function.
  function stopChild() {
    process.removeListener("exit", stopOnExit);
    if (stopped || !child.pid) return;
    stopped = true;
    try { process.kill(-child.pid, "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") console.error("Filesystem namespace cleanup:", error); }
  }
}
