// Tests real socket framing, interruption and deadlines without provisioning
// Linux namespaces or calling an external provider.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestFilesystemNamespace } from "../../src/modules/supervisor/filesystem-namespace-client.js";

// Creates an isolated Unix socket and destroys accepted connections on cleanup
// so a failed framing assertion cannot leave the test process alive.
async function fixture(t, reply) {
  const root = await mkdtemp(join(tmpdir(), "nf-namespace-socket-"));
  const path = join(root, "runner.sock");
  const clients = new Set();
  const server = createServer(socket => { clients.add(socket); socket.on("error", error => assert.ok(error)); socket.once("data", chunk => reply(socket, JSON.parse(chunk))); });
  await new Promise(resolve => server.listen(path, resolve));
  t.after(async () => { for (const client of clients) client.destroy(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return path;
}

// Fragmented transport frames must preserve exact stdout and the terminal receipt.
test("namespace client streams frames and returns only the terminal execution result", async t => {
  const path = await fixture(t, (socket, request) => {
    assert.equal(request.action, "run");
    socket.write('{"stream":"stdout","data":"pa');
    socket.end('ss"}\n{"exitCode":0,"receiptPath":"/receipt.json"}\n');
  });
  const output = [];
  const result = await requestFilesystemNamespace(path, { action: "run" }, { onOutput: (...frame) => output.push(frame) });
  assert.deepEqual(output, [["stdout", "pass"]]); assert.equal(result.receiptPath, "/receipt.json");
});

// Neither truncated responses nor reported setup errors may be mistaken for a passing check.
test("incomplete or rejected runner responses never return a successful result", async t => {
  const incomplete = await fixture(t, socket => socket.end('{"exitCode":0'));
  await assert.rejects(requestFilesystemNamespace(incomplete, { action: "run" }), { code: "VERIFY_RUNNER_DISCONNECTED" });
  const rejected = await fixture(t, socket => socket.end('{"error":"denied","exitCode":1}\n'));
  await assert.rejects(requestFilesystemNamespace(rejected, { action: "run" }), { code: "VERIFY_RUNNER_FAILED" });
});

// Stop and timeouts must close the transport, allowing the server to kill its verifier.
test("cancelled or timed-out socket requests return bounded failures", async t => {
  let began;
  const ready = new Promise(resolve => { began = resolve; });
  const path = await fixture(t, () => began());
  const controller = new AbortController();
  const run = requestFilesystemNamespace(path, { action: "run" }, { signal: controller.signal });
  await ready; controller.abort(new Error("owner stopped"));
  await assert.rejects(run, /owner stopped/);
  await assert.rejects(requestFilesystemNamespace(path, { action: "status" }, { timeoutMs: 10 }), { code: "VERIFY_RUNNER_TIMEOUT" });
});
