// Starts a retained Linux namespace runner and sends verification requests over
// its owner-only socket. Missing UID helpers fail before fixture allocation;
// package installation and subordinate-ID policy remain operator responsibilities.
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { chmod, mkdir, mkdtemp, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPOSITORY_ROOT } from "../src/shared/repository-root.js";
import { namespaceProcess } from "../test-environments/filesystem/namespace-launch.mjs";
import { namespaceDiagnostics } from "../test-environments/filesystem/namespace-diagnostics.mjs";

const [action, ...args] = process.argv.slice(2);
const scratch = join(REPOSITORY_ROOT, ".forge/scratch");
const server = fileURLToPath(new URL("../test-environments/filesystem/namespace-server.mjs", import.meta.url));
if (action === "diagnose") {
  await mkdir(scratch, { recursive: true });
  const report = namespaceDiagnostics();
  const receiptPath = join(scratch, "filesystem-namespace-diagnostics.receipt.json");
  await writeFile(receiptPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ receiptPath, ...report }, null, 2));
  process.exitCode = report.probes.some(probe => probe.exitCode !== 0) ? 1 : 0;
} else if (action === "probe" || action === "start") {
  if (process.geteuid() !== 1000 || process.getegid() !== 1000) {
    throw new Error("VERIFICATION_BLOCKED: this runner maps the current host UID/GID 1000 to verifier UID/GID 1000");
  }
  await mkdir(scratch, { recursive: true });
  const launch = namespaceProcess(["-e",
    'const fs=require("node:fs");console.log(JSON.stringify({uid:process.geteuid(),gid:process.getegid(),uidMap:fs.readFileSync("/proc/self/uid_map","utf8"),gidMap:fs.readFileSync("/proc/self/gid_map","utf8")}))']);
  const probe = spawnSync(launch.command, launch.argv, { encoding: "utf8", timeout: 30000, killSignal: "SIGKILL" });
  const receipt = { timestamp: new Date().toISOString(), command: launch.command, argv: launch.argv,
    exitCode: probe.status ?? 1, error: probe.error?.message ?? null, stdout: probe.stdout, stderr: probe.stderr };
  const receiptPath = join(scratch, "filesystem-namespace-probe.receipt.json");
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ receiptPath, ...receipt }));
  if (probe.error || probe.status !== 0) {
    const diagnostic = probe.error?.message || probe.stderr?.trim() || `unshare exited ${probe.status}`;
    console.error(`VERIFICATION_BLOCKED: ${diagnostic}\nReceipt: ${receiptPath}`);
    process.exitCode = 1;
  } else if (action === "start") {
    const control = await mkdtemp(join(scratch, "fs-ns-"));
    await chmod(control, 0o700);
    await mkdir(join(control, "fixtures"));
    console.log(JSON.stringify({ control, socketPath: join(control, "runner.sock"), lifecycle: "Keep this foreground runner alive until review; use stop for cleanup." }));
    const retained = namespaceProcess([server, control, resolve(REPOSITORY_ROOT)], { retained: true });
    const child = spawn(retained.command, retained.argv, { stdio: "inherit" });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      process.exitCode = await new Promise((done, reject) => { child.once("error", reject); child.once("close", code => done(code ?? 1)); });
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      // The host mountpoint is empty after the namespace exits. Receipts and the
      // manifest snapshot remain in the session directory for audit and review.
      await rmdir(join(control, "fixtures"));
    }
  }
} else if (["run", "status", "stop"].includes(action)) {
  const socketPath = process.env.NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET;
  if (!socketPath || !resolve(socketPath).startsWith(`${resolve(scratch)}/fs-ns-`) || !socketPath.endsWith("/runner.sock")) {
    throw new Error("VERIFICATION_BLOCKED: set NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET to the retained project runner socket");
  }
  const separator = args.indexOf("--");
  const cwd = args[0] === "--cwd" ? resolve(args[1]) : resolve(REPOSITORY_ROOT);
  const argv = separator >= 0 ? args.slice(separator + 1) : [process.execPath, "--test", "--test-reporter=tap", "backend/tests/integration/project-filesystem-environment.test.js"];
  await new Promise((done, reject) => {
    const socket = createConnection(socketPath);
    let pending = "";
    let completed = false;
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify({ action, cwd, argv }) + "\n"));
    socket.on("data", chunk => {
      pending += chunk;
      const frames = pending.split("\n");
      pending = frames.pop();
      for (const line of frames) {
        const frame = JSON.parse(line);
        if (frame.stream) process[frame.stream].write(frame.data);
        else console.log(JSON.stringify(frame));
        if (frame.identity || frame.exitCode !== undefined) completed = true;
        if (frame.exitCode !== undefined) process.exitCode = frame.exitCode;
      }
    });
    socket.once("end", () => completed ? done() : reject(new Error("VERIFICATION_BLOCKED: runner closed without a result")));
  });
} else {
  throw new Error("Usage: node backend/scripts/verify-filesystem-namespace.mjs diagnose|probe|start|status|run|stop [--cwd project-directory -- node argv...]");
}
