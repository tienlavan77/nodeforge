// Provides real temporary project roots and bounded lifecycle assertions without external Ollama access.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createControlApiConfig } from "../../scripts/control-api-config.mjs";
import { createProjectLifecycle, routeProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";
import { formatErrorBody } from "../../src/shared/error-contract.js";
import { runCli } from "../../src/transport/cli/index.js";

// Starts an in-process HTTP server exposing the Control API lifecycle management endpoints for integration tests.
export async function startLifecycleHttpServer(projectLifecycle) {
  const server = createServer(async (request, res) => {
    const requestId = "REQ-test";
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const routed = await routeProjectLifecycle(request.method ?? "GET", url, request, projectLifecycle);
      if (!routed) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(formatErrorBody({ statusCode: 404, requestId, fallbackMessage: "Not Found" })));
        return;
      }
      res.statusCode = routed.status ?? 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(routed.body));
    } catch (error) {
      const statusCode = error?.statusCode ?? 500;
      res.statusCode = statusCode;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(formatErrorBody({ error, statusCode, requestId, fallbackMessage: error?.message ?? "Request failed." })));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

// Executes the thin CLI against a target Control API server URL and captures stdout, stderr, and exit code.
export async function runLifecycleCli(args, { env = {}, fetchImpl = globalThis.fetch } = {}) {
  let out = "";
  let err = "";
  const code = await runCli(args, {
    env,
    fetchImpl,
    stdout: { write: (chunk) => { out += String(chunk); } },
    stderr: { write: (chunk) => { err += String(chunk); } }
  });
  return { code, stdout: out.trim(), stderr: err.trim(), json: out.trim() ? JSON.parse(out.trim()) : null };
}

export { createControlApiConfig };
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";

// Creates two actual indexed roots while keeping global catalog metadata outside both roots.
export async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "forge-multi-project-"));
  const roots = [join(directory, "first"), join(directory, "second")];
  for (const [index, root] of roots.entries()) {
    await mkdir(root);
    await writeFile(join(root, "sample.js"), `export function project${index}() { return ${index}; }\n`);
  }
  const logs = [];
  const logger = {
    // Records expected operational failures for affected-project diagnostic assertions.
    error(message, detail) { logs.push({ message, detail }); },
    // Records retryable embedding failures without printing test noise.
    warn(message, detail) { logs.push({ message, detail }); }
  };
  const providers = [];
  const catalogPath = join(directory, "global", "projects.json");
  const managers = [];
  // Starts real watcher, SQLite, stream, and embedding services for every admitted root.
  async function startRuntime(input) {
    const provider = {
      // Supplies deterministic vectors while still exercising the durable embedding worker.
      async embed() { return [1, 0, 0]; },
      // Records provider cleanup independently for each project runtime.
      async close() { provider.closed = true; }
    };
    providers.push(provider);
    return startProjectRuntime({ ...input, embeddingProvider: provider });
  }
  // Restores catalog membership with independent runtime services after process-style shutdown.
  async function open(overrides = {}) {
    const manager = await createProjectLifecycle({ catalogPath, logger, startRuntime, ...options, ...overrides });
    managers.push(manager);
    return manager;
  }
  // Releases every manager before deleting temporary runtime databases and project identities.
  async function cleanup() {
    try { await Promise.all(managers.map((manager) => manager.close())); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  return { directory, roots, catalogPath, providers, logs, logger, open, cleanup };
}

// Waits for executable watcher/worker state transitions with an explicit failure deadline.
export async function waitFor(predicate, message = "Lifecycle transition did not finish.") {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  assert.fail(message);
}

// Counts Linux process descriptors so repeated add/remove can detect resource leaks.
export async function fdCount() {
  return (await readdir("/proc/self/fd")).length;
}

// Captures the existing SSE projection while retaining client-disconnect behavior.
export function response() {
  const sink = new EventEmitter();
  sink.chunks = [];
  // Collects emitted stream frames for project-isolation and snapshot assertions.
  sink.write = (chunk) => sink.chunks.push(chunk);
  // Records stream shutdown so removal can prove that live clients are released.
  sink.end = () => { sink.writableEnded = true; sink.emit("close"); };
  return sink;
}
