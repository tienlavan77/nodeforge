// Owns on-demand filesystem verification sessions per project. Agent requests
// reuse healthy sockets, replace dead sessions, and never stop operator runners.
import { realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { startFilesystemNamespace } from "./filesystem-namespace-process.js";
import { requestFilesystemNamespace } from "./filesystem-namespace-client.js";

const managers = new Map();

// Shares one serialized lifecycle across Coder and Reviewer services in the API.
export async function runFilesystemNamespace(input) {
  const root = await realpath(input.projectRoot);
  if (!managers.has(root)) managers.set(root, createFilesystemNamespaceRunner({ projectRoot: root,
    configuredSocket: () => process.env.NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET?.startsWith(join(root, ".forge/scratch/"))
      ? process.env.NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET : undefined,
    onEvent: (status) => console.info(`[Verification] Filesystem namespace runner ${status}; project=${root}`) }));
  return managers.get(root).run(input);
}

// Business purpose: reclaims the cached filesystem namespace runner and its underlying socket/process when a target project is closed or removed from the multi-project lifecycle.
// Technical description: resolves the canonical project root, deletes the runner entry from the process-wide managers map, and awaits manager.close().
export async function closeFilesystemNamespaceRunner(projectRoot) {
  if (!projectRoot) return;
  let root;
  try { root = await realpath(projectRoot); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    root = resolve(projectRoot);
  }
  const manager = managers.get(root);
  if (!manager) return;
  managers.delete(root);
  await manager.close();
}

// Keeps startup, test execution and idle cleanup in one queue so concurrent
// tickets cannot launch duplicate managed sessions or stop an active verifier.
export function createFilesystemNamespaceRunner({ projectRoot, start = startFilesystemNamespace, request = requestFilesystemNamespace,
  configuredSocket = () => process.env.NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET, idleMs = 300000, onEvent = () => {} } = {}) {
  let session;
  let timer;
  let tail = Promise.resolve();
  return Object.freeze({ run, close });

  // Executes the exact Node argv and archive cwd and returns a small environment
  // receipt, leaving full streamed output in the caller's verification evidence.
  async function run({ argv, cwd, signal, timeoutMs, onOutput }) {
    return exclusive(async () => {
      signal?.throwIfAborted();
      clearTimeout(timer);
      try {
        const current = await ensure(signal);
        const result = await request(current.socketPath, { action: "run", argv, cwd }, { signal, timeoutMs, onOutput });
        if (!Number.isInteger(result.exitCode) || typeof result.receiptPath !== "string"
          || dirname(result.receiptPath) !== dirname(current.socketPath)) throw new Error("Filesystem namespace returned an invalid verification receipt.");
        return { exit_code: result.exitCode, runtime_environment: { type: "filesystem_namespace", socket_path: current.socketPath,
          manifest_path: current.identity.manifestPath, manifest_sha256: current.identity.checksum, receipt_path: result.receiptPath,
          runner_pid: current.identity.pid, managed: Boolean(current.stop) } };
      } finally {
        if (session?.stop) {
          timer = setTimeout(() => { void close().catch(error => console.error("Filesystem runner idle cleanup:", error)); }, idleMs);
          timer.unref?.();
        }
      }
    }, signal);
  }

  // Stops only a Node-owned idle session after all earlier requests finish.
  async function close() {
    return exclusive(async () => {
      clearTimeout(timer);
      const current = session;
      session = undefined;
      await current?.stop?.();
      if (current?.stop) onEvent("stopped");
    });
  }

  // Probes before reuse and replaces only unavailable sockets. Identity and
  // permission failures remain explicit errors rather than silently switching hosts.
  async function ensure(signal) {
    const socketPath = session?.socketPath ?? configuredSocket();
    if (socketPath) {
      validateSocket(socketPath);
      try {
        const { identity } = await request(socketPath, { action: "status" }, { signal });
        validateIdentity(identity, socketPath);
        session = { ...session, socketPath, identity };
        return session;
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED", "VERIFY_RUNNER_DISCONNECTED", "VERIFY_RUNNER_TIMEOUT"].includes(error.code)) throw error;
        await session?.stop?.();
        session = undefined;
      }
    }
    onEvent("starting");
    const created = await start({ projectRoot, signal });
    try {
      validateSocket(created.socketPath);
      validateIdentity(created.identity, created.socketPath);
      session = created;
      onEvent("ready");
      return created;
    } catch (error) { await created.stop(); throw error; }
  }

  // Limits service selection to a project-local session; agents never supply a
  // host path and another project's configured socket cannot be reused.
  function validateSocket(socketPath) {
    if (resolve(socketPath) !== socketPath || !socketPath.startsWith(join(projectRoot, ".forge/scratch/fs-ns-")) || !/^fs-ns-[A-Za-z0-9]+$/.test(dirname(socketPath).split("/").at(-1))
      || !socketPath.endsWith("/runner.sock")) throw Object.assign(new Error("Filesystem runner socket belongs to another project or is noncanonical."), { code: "VERIFY_RUNNER_SCOPE" });
  }

  // Treats socket readiness as provisioning evidence, never as a passing test.
  function validateIdentity(identity, socketPath) {
    if (identity?.repository !== projectRoot || identity.socketPath !== socketPath || identity.status !== "provisioned"
      || !/^[a-f0-9]{64}$/.test(identity.checksum ?? "") || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
      || identity.manifestPath !== join(dirname(socketPath), "fixtures/manifest.json"))
      throw Object.assign(new Error("Filesystem runner identity does not match the requested project."), { code: "VERIFY_RUNNER_SCOPE" });
  }

  // Serializes without retaining rejected promises; every caller receives its
  // own failure and a later request can retry after repairing infrastructure.
  async function exclusive(operation, signal) {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    try {
      if (signal) await new Promise((resolve, reject) => {
        // Defines abort function behavior for filesystem-namespace-runner.js.
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        previous.then(() => { signal.removeEventListener("abort", abort); resolve(); });
      });
      else await previous;
    } catch (error) { void previous.then(release); throw error; }
    try { return await operation(); } finally { release(); }
  }
}
