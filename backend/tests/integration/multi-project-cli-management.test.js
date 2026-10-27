// Proves separate thin CLI processes manage the serving process's real project runtimes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHttpApi } from "../../src/transport/http/server.js";
import { fixture, startLifecycleHttpServer } from "./multi-project-lifecycle-support.js";

// Runs the shipped executable without sharing runtime objects or mocked HTTP with the server.
async function invokeCli(serverUrl, action, root, options = []) {
  const executable = fileURLToPath(new URL("../../src/transport/cli/index.js", import.meta.url));
  const args = [executable, "project", action, ...(root ? [root] : []), ...options, "--server", serverUrl];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, NODEFORGE_CONTROL_API_URL: "http://127.0.0.1:1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, `CLI failed: ${stderr}`);
    assert.equal(stderr, "");
    return JSON.parse(stdout);
  } finally { clearTimeout(timeout); }
}

// Checks lifecycle dispatch preserves unknown paths, CORS, errors, and unmatched-router fallback.
test("HTTP lifecycle dispatch is narrow and tolerates unmatched router results", async () => {
  const calls = [];
  const api = createHttpApi({ forgeV1Router: { route: async (...args) => { calls.push(args); return null; } } });
  const server = api.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ["/lifecycle/list", "/lifecycle/unknown", "/unrelated"]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { origin: "http://localhost:3100" } });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3100");
      assert.equal((await response.json()).error.message, "Route not found.");
    }
    assert.equal(calls.length, 1);
    const options = await fetch(`${baseUrl}/lifecycle/add`, { method: "OPTIONS" });
    assert.equal(options.status, 204);
    assert.equal(calls.length, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

// Starts the shipped Control API bootstrap with isolated storage and bounded process cleanup.
async function startServingControlApi(projectRoot, catalogPath) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const executable = fileURLToPath(new URL("../../scripts/start-control-api.mjs", import.meta.url));
  // Mount the managed temporary catalog outside .forge so production path validation remains intact.
  const sandboxCatalog = catalogPath?.split("/").includes(".forge");
  const catalogMount = "/tmp/nodeforge-lifecycle-catalog";
  const child = spawn(sandboxCatalog ? "/usr/bin/bwrap" : process.execPath, sandboxCatalog ? [
    "--unshare-user", "--uid", "0", "--gid", "0", "--ro-bind", "/", "/",
    "--bind", dirname(projectRoot), dirname(projectRoot), "--tmpfs", "/tmp",
    "--bind", dirname(catalogPath), catalogMount, "--die-with-parent", "--new-session", "--info-fd", "3",
    "--", process.execPath, executable
  ] : [executable], {
    env: { ...process.env, NODE_CONTROL_PROJECT_ROOT: projectRoot,
      NODE_CONTROL_DATA_DIR: join(projectRoot, ".forge", "runtime", "nf"),
      NODE_CONTROL_PORT: String(port), NODE_CONTROL_HOST: "127.0.0.1",
      NODEFORGE_PROJECT_CATALOG_PATH: sandboxCatalog ? join(catalogMount, basename(catalogPath)) : catalogPath ?? "" },
    stdio: sandboxCatalog ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let servingPid;
  if (sandboxCatalog) {
    let info = "";
    child.stdio[3].on("data", (chunk) => { info += chunk; });
    child.stdio[3].once("end", () => {
      try { servingPid = JSON.parse(info)["child-pid"]; } catch (error) { output += "Namespace PID: " + error.message; }
    });
  }
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // Awaits runtime shutdown before deleting the serving process's temporary databases.
  async function close() {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (sandboxCatalog) {
          assert.ok(Number.isSafeInteger(servingPid), "Namespace must report the actual serving PID");
          process.kill(servingPid, "SIGTERM");
        } else child.kill("SIGTERM");
      }
      const result = await exited;
      assert.equal(result.code, 0, `Control API shutdown failed: ${output}`);
    } finally { clearTimeout(timeout); }
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(`Control API exited: ${output}`);
      try {
        const response = await fetch(`${baseUrl}/lifecycle/list`, { signal: AbortSignal.timeout(500) });
        if (response.status === (catalogPath ? 200 : 503)) return { baseUrl, close };
      } catch (error) {
        output = `${output.slice(-12000)}\nStartup probe: ${error.message}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`Control API did not become ready: ${output}`);
  } catch (error) {
    try { await close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Serving bootstrap and cleanup failed.");
    }
    throw error;
  }
}

// Proves shipped bootstrap compatibility and thin-client management across actual process restarts.
test("shipped Control API owns lifecycle runtimes and retains legacy startup", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodeforge-serving-"));
  const original = join(directory, "original");
  const roots = [join(directory, "first"), join(directory, "second")];
  const catalogPath = join(directory, "projects.json");
  let serving;
  try {
    for (const root of [original, ...roots]) {
      await mkdir(root);
      await writeFile(join(root, "sample.js"), "export function sample() { return 1; }\n");
    }
    serving = await startServingControlApi(original);
    const legacy = await fetch(`${serving.baseUrl}/lifecycle/list`);
    assert.equal(legacy.status, 503);
    assert.equal((await legacy.json()).error.code, "lifecycle_unavailable");
    const workspace = await fetch(`${serving.baseUrl}/projects/PROJECT-NODEFORGE/architecture-workspace`);
    assert.equal(workspace.status, 200);
    await serving.close();
    serving = undefined;
    serving = await startServingControlApi(original, catalogPath);
    const first = (await invokeCli(serving.baseUrl, "add", roots[0])).project;
    const second = (await invokeCli(serving.baseUrl, "add", roots[1])).project;
    assert.notEqual(first.project_id, second.project_id);
    assert.deepEqual((await invokeCli(serving.baseUrl, "list")).projects, [first, second]);
    await serving.close();
    serving = undefined;
    serving = await startServingControlApi(original, catalogPath);
    assert.deepEqual((await invokeCli(serving.baseUrl, "list")).projects, [first, second]);
    assert.deepEqual(await invokeCli(serving.baseUrl, "remove", first.root), { root: first.root, removed: true });
    assert.deepEqual(await invokeCli(serving.baseUrl, "remove", first.root), { root: first.root, removed: false });
    assert.deepEqual((await invokeCli(serving.baseUrl, "list")).projects, [second]);
    assert.deepEqual(await invokeCli(serving.baseUrl, "remove", second.root), { root: second.root, removed: true });
  } finally {
    try { await serving?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});

// Proves new CLI receipts survive backend restart while legacy list continues to report serving projects.
test("opt-in executable reconciles retained request keys across backend restart", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let manager = await f.open();
  let server = await startLifecycleHttpServer(manager);
  t.after(() => server.close());
  const options = ["--lifecycle-v1", "--request-key", "retained-cli"];
  const accepted = await invokeCli(server.baseUrl, "add", f.roots[0], options);
  await manager.operations.close();
  const done = await invokeCli(server.baseUrl, "status", undefined, options);
  assert.equal(done.operation.status, "succeeded");
  assert.equal(done.operation.operation_id, accepted.operation.operation_id);
  assert.deepEqual((await invokeCli(server.baseUrl, "list")).projects,
    [{ root: f.roots[0], project_id: done.operation.project_id }]);
  await server.close();
  await manager.close();
  manager = await f.open();
  server = await startLifecycleHttpServer(manager);
  const retained = await invokeCli(server.baseUrl, "status", undefined, options);
  assert.equal(retained.operation.operation_id, done.operation.operation_id);
  assert.equal(retained.operation.attempt, 1);
  const reconciled = await invokeCli(server.baseUrl, "add", f.roots[0], options);
  assert.equal(reconciled.operation.attempt, 1);
});

// Verifies admission, stable identity, duplicate admission, removal, and restart through actual CLI HTTP requests.
test("thin CLI manages two projects owned by one serving process", { timeout: 60000 }, async () => {
  const context = await fixture();
  let server;
  try {
    const manager = await context.open();
    server = await startLifecycleHttpServer(manager);
    assert.deepEqual(await invokeCli(server.baseUrl, "list"), { projects: [], startup_errors: [] });
    const first = (await invokeCli(server.baseUrl, "add", context.roots[0])).project;
    const second = (await invokeCli(server.baseUrl, "add", context.roots[1])).project;
    assert.match(first.project_id, /^PROJECT-[0-9a-f-]{36}$/);
    assert.notEqual(first.project_id, second.project_id);
    assert.deepEqual((await invokeCli(server.baseUrl, "add", context.roots[0])).project, first);
    const listed = await invokeCli(server.baseUrl, "list");
    assert.deepEqual(listed, { projects: [first, second], startup_errors: [] });
    assert.equal(manager.list().length, 2);
    const firstRuntime = await manager.get(first.root);
    const secondRuntime = await manager.get(second.root);
    assert.notEqual(firstRuntime.worker, secondRuntime.worker);
    assert.notEqual(firstRuntime.database, secondRuntime.database);
    assert.equal(firstRuntime.status().closed, false);
    assert.equal(secondRuntime.status().closed, false);
    assert.deepEqual(await invokeCli(server.baseUrl, "remove", first.root), { root: first.root, removed: true });
    assert.equal(firstRuntime.status().closed, true);
    assert.equal(context.providers[0].closed, true);
    assert.equal(await manager.get(first.root), undefined);
    assert.equal(secondRuntime.status().closed, false);
    assert.deepEqual(await invokeCli(server.baseUrl, "remove", first.root), { root: first.root, removed: false });
    assert.deepEqual((await invokeCli(server.baseUrl, "list")).projects, [second]);
    await server.close();
    server = undefined;
    await manager.close();
    assert.equal(secondRuntime.status().closed, true);
    const restored = await context.open();
    server = await startLifecycleHttpServer(restored);
    assert.deepEqual((await invokeCli(server.baseUrl, "list")).projects, [second]);
    assert.deepEqual((await invokeCli(server.baseUrl, "add", first.root)).project, first);
    assert.equal(restored.list().length, 2);
  } finally {
    try { await server?.close(); }
    finally { await context.cleanup(); }
  }
});
