// Exercises shared runner ownership and recovery without privileged fixtures.
// The fake transport distinguishes provisioning, test execution and cleanup.
import assert from "node:assert/strict";
import test from "node:test";
import { createFilesystemNamespaceRunner } from "../../src/modules/supervisor/filesystem-namespace-runner.js";

// Models independent caller lifetimes against a single project-owned service.
function fixture({ external = false, startFailure = false, idleMs = 10000 } = {}) {
  let starts = 0, stops = 0, runs = 0, alive = external, active = 0, maximum = 0;
  let hold;
  const root = "/project";
  const socketPath = root + "/.forge/scratch/fs-ns-abc123/runner.sock";
  const identity = { repository: root, socketPath, manifestPath: root + "/.forge/scratch/fs-ns-abc123/fixtures/manifest.json",
    status: "provisioned", pid: 123, checksum: "a".repeat(64) };
  const runner = createFilesystemNamespaceRunner({ projectRoot: root, idleMs, configuredSocket: () => external ? socketPath : undefined,
    start: async ({ signal }) => { starts++; signal?.throwIfAborted(); if (startFailure) throw new Error("UID mapping unavailable"); alive = true;
      return { socketPath, identity, stop: async () => { stops++; alive = false; } }; },
    request: async (_socket, input, { signal, onOutput } = {}) => {
      signal?.throwIfAborted();
      if (!alive) throw Object.assign(new Error("socket absent"), { code: "ENOENT" });
      if (input.action === "status") return { identity };
      runs++; active++; maximum = Math.max(maximum, active);
      try {
        await hold?.(); signal?.throwIfAborted(); onOutput?.("stdout", "test output");
        return { exitCode: 0, receiptPath: root + "/.forge/scratch/fs-ns-abc123/verification-real.json" };
      } finally { active--; }
    } });
  return { runner, identity, input: { argv: [process.execPath, "--test", "backend/tests/test.test.js"], cwd: root, timeoutMs: 1000 },
    counts: () => ({ starts, stops, runs, maximum }), die: () => { alive = false; }, hold: callback => { hold = callback; } };
}

// Concurrent agent checks must share startup while their verifier processes remain serialized.
test("Coder and Reviewer share one managed runner and receive separate execution receipts", async () => {
  const f = fixture();
  try {
    const output = [];
    const [coder, reviewer] = await Promise.all([f.runner.run({ ...f.input, onOutput: (...frame) => output.push(frame) }), f.runner.run(f.input)]);
    assert.deepEqual(f.counts(), { starts: 1, stops: 0, runs: 2, maximum: 1 });
    assert.equal(coder.runtime_environment.managed, true); assert.equal(reviewer.exit_code, 0);
    assert.equal(coder.runtime_environment.manifest_sha256, f.identity.checksum);
    assert.match(coder.runtime_environment.receipt_path, /verification-real.json$/);
    assert.deepEqual(output, [["stdout", "test output"]]);
  } finally { await f.runner.close(); }
  assert.equal(f.counts().stops, 1);
});

// An operator's retained fixture environment is reusable but never owned by Node cleanup.
test("healthy external runner is reused and never stopped by idle or API cleanup", async () => {
  const f = fixture({ external: true, idleMs: 1 });
  const receipt = await f.runner.run(f.input);
  await new Promise(resolve => setTimeout(resolve, 10)); await f.runner.close();
  assert.equal(receipt.runtime_environment.managed, false);
  assert.deepEqual(f.counts(), { starts: 0, stops: 0, runs: 1, maximum: 1 });
});

// A dead session is replaced on demand without interpreting an earlier test pass as readiness.
test("dead managed or configured socket is replaced before the next check", async () => {
  for (const external of [false, true]) {
    const f = fixture({ external });
    try {
      await f.runner.run(f.input); f.die(); await f.runner.run(f.input);
      assert.equal(f.counts().starts, external ? 1 : 2);
      assert.equal(f.counts().runs, 2);
    } finally { await f.runner.close(); }
  }
});

// Stopped requests cannot allocate fixtures or wait for another ticket's long test.
test("Stop before startup and while queued prevents execution and returns immediately", async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort(new Error("stopped"));
  await assert.rejects(f.runner.run({ ...f.input, signal: controller.signal }), /stopped/);
  assert.equal(f.counts().starts, 0);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  f.hold(async () => { entered(); await held; });
  const first = f.runner.run(f.input); await ready;
  const queued = new AbortController();
  const second = f.runner.run({ ...f.input, signal: queued.signal });
  queued.abort(new Error("queued stop"));
  await assert.rejects(second, /queued stop/);
  release(); await first; await f.runner.close();
  assert.equal(f.counts().runs, 1);
});

// Startup errors must be explicit blockers and idle cleanup must affect only owned sessions.
test("setup failure executes no tests; owned idle sessions are reclaimed", async () => {
  const failed = fixture({ startFailure: true });
  await assert.rejects(failed.runner.run(failed.input), /UID mapping unavailable/);
  assert.equal(failed.counts().runs, 0);
  const f = fixture({ idleMs: 1 });
  await f.runner.run(f.input); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.counts().stops, 1); await f.runner.close();
});

// Cross-project and noncanonical endpoints cannot become verification authority.
test("wrong project identity and traversal are rejected before any verifier starts", async () => {
  const f = fixture({ external: true }); f.identity.repository = "/other";
  await assert.rejects(f.runner.run(f.input), { code: "VERIFY_RUNNER_SCOPE" });
  assert.equal(f.counts().runs, 0);
  const runner = createFilesystemNamespaceRunner({ projectRoot: "/project", configuredSocket: () => "/project/.forge/scratch/fs-ns-a/../fs-ns-b/runner.sock" });
  await assert.rejects(runner.run(f.input), { code: "VERIFY_RUNNER_SCOPE" });
});
