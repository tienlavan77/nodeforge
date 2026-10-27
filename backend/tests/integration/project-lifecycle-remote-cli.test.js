// Proves the shipped thin CLI works when server project paths do not exist in its mount namespace.
// Backend admission remains real, including identity and filesystem changes. Interrupted mutations,
// retained keys, explicit retry and observation-only status commands exercise separate HTTP actions.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { access } from "node:fs/promises";
import { fixture, startLifecycleHttpServer } from "./multi-project-lifecycle-support.js";
import { runLifecycleCli } from "../../src/transport/cli/project-lifecycle.js";

// Executes the real CLI with server roots hidden by a private mount, failing if namespace setup fails.
async function remote(baseUrl, serverRoot, args) {
  const runner = fileURLToPath(new URL("./project-lifecycle-remote-client.js", import.meta.url));
  const child = spawn("/usr/bin/bwrap", ["--unshare-user", "--uid", "0", "--gid", "0",
    "--ro-bind", "/", "/", "--tmpfs", dirname(serverRoot), "--die-with-parent", "--new-session",
    "--", process.execPath, runner, serverRoot, "project", ...args, "--lifecycle-v1", "--server", baseUrl],
    { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { code, err, values: out.trim() ? out.trim().split("\n").map((line) => JSON.parse(line)) : [] };
  } finally { clearTimeout(timer); }
}

// Reads operation status without replaying admission and bounds eventual assertions for disconnected clients.
async function settle(lifecycle, key) {
  for (let i = 0; i < 300; i++) {
    const operation = await lifecycle.operations.status(key);
    if (["failed", "succeeded"].includes(operation.status)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Backend operation did not finish");
}

test("remote CLI Create/Add, directory and following never access server project files", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const lifecycle = await f.open();
  const server = await startLifecycleHttpServer(lifecycle);
  t.after(server.close);
  const add = await remote(server.baseUrl, f.roots[0], ["add", f.roots[0], "--request-key", "remote-add", "--follow"]);
  assert.equal(add.code, 0, add.err);
  assert.equal(add.values[0].operation.attempt, 1);
  assert.equal(add.values.at(-1).operation.status, "succeeded");
  const createdRoot = f.roots[0] + "-new";
  const create = await remote(server.baseUrl, f.roots[0], ["create", createdRoot, "--request-key", "remote-create", "--follow"]);
  assert.equal(create.code, 0, create.err);
  assert.equal(create.values.at(-1).operation.status, "succeeded");
  await access(createdRoot + "/.forge/runtime/project.json");
  const directory = await remote(server.baseUrl, f.roots[0], ["directory"]);
  assert.equal(directory.code, 0, directory.err);
  assert.equal(directory.values[0].projects.length, 2);
  const status = await remote(server.baseUrl, f.roots[0], ["status", "--request-key", "remote-create"]);
  assert.equal(status.code, 0, status.err);
  assert.equal(status.values[0].operation.attempt, 1);
});

test("disconnect and lost response reconcile without replay; retry and status reload stay distinct", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let fail = true;
  let starts = 0;
  const lifecycle = await f.open({ startRuntime: async ({ projectRoot, projectId }) => {
    starts++;
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (fail) throw new Error("temporary startup failure");
    return { projectRoot, projectId, close() {} };
  } });
  const server = await startLifecycleHttpServer(lifecycle);
  t.after(server.close);
  const headers = { "content-type": "application/json", "x-nodeforge-lifecycle": "1" };
  const response = await fetch(server.baseUrl + "/lifecycle/operations/add", {
    method: "POST", headers, body: JSON.stringify({ root: f.roots[0], request_key: "lost-response" })
  });
  await response.body.cancel();
  assert.equal((await settle(lifecycle, "lost-response")).status, "failed");
  const status = await remote(server.baseUrl, f.roots[0], ["status", "--request-key", "lost-response"]);
  assert.equal(status.code, 2, status.err);
  assert.equal(starts, 1);
  const same = await remote(server.baseUrl, f.roots[0], ["add", f.roots[0], "--request-key", "lost-response"]);
  assert.equal(same.code, 2, same.err);
  assert.equal(starts, 1);
  fail = false;
  const retry = await remote(server.baseUrl, f.roots[0], ["retry", "--request-key", "lost-response", "--expected-attempt", "1", "--follow"]);
  assert.equal(retry.code, 0, retry.err);
  assert.equal(retry.values.at(-1).operation.attempt, 2);
  assert.equal(starts, 2);
  const observation = await remote(server.baseUrl, f.roots[0], ["add", f.roots[1], "--request-key", "observe-once"]);
  assert.equal(observation.code, 0, observation.err);
  assert.equal((await settle(lifecycle, "observe-once")).status, "succeeded");
  assert.equal(starts, 3);
});

test("CLI never automatically retries a mutation after transport timeout", async () => {
  let calls = 0;
  let stderr = "";
  const code = await runLifecycleCli(["project", "add", "/server-only/root", "--lifecycle-v1",
    "--server", "http://localhost:1234", "--request-key", "uncertain"], {
    env: {}, stdout: { write() {} }, stderr: { write(value) { stderr += value; } },
    fetchImpl: async () => { calls++; throw new Error("timeout"); }
  });
  assert.equal(code, 1);
  assert.equal(calls, 1);
  assert.match(stderr, /status --request-key uncertain/);
});
