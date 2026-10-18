// Proves separate thin CLI processes manage the serving process's real project runtimes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixture, startLifecycleHttpServer } from "./multi-project-lifecycle-support.js";

// Runs the shipped executable without sharing runtime objects or mocked HTTP with the server.
async function invokeCli(serverUrl, action, root) {
  const executable = fileURLToPath(new URL("../../src/transport/cli/index.js", import.meta.url));
  const args = [executable, "project", action, ...(root ? [root] : []), "--server", serverUrl];
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
