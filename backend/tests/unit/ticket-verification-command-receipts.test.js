/** Guards durable PASS reuse against stale source, dependency changes, corrupt
 * evidence and external runner state without accepting failed verification. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTicketCommandReceipts } from "../../src/modules/supervisor/ticket/ticket-verification-command-receipts.js";
import { runTicketVerificationCommands } from "../../src/modules/supervisor/ticket/ticket-verification-regression.js";

/** Gives each test an isolated persistence adapter and a complete input identity. */
async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "nf-command-receipts-"));
  const store = new Map();
  const commands = [{ kind: "lint", argv: [process.execPath, "lint.js"] }, { kind: "backend_tests", argv: [process.execPath, "--test", "test.js"], test_paths: ["test.js"] }];
  const options = { projectRoot, taskId: "T-RECEIPTS", commands, context: { review_commit_sha: "commit" },
    job: { job_id: "VERIFY-1", runner_revision: "runner", policy_version: "policy" }, checksums: { "source.js": "content" }, environment: { sha256: "environment" },
    stateFileService: { readFile: async ({ path }) => { if (!store.has(path)) throw Object.assign(Error("absent"), { code: "ENOENT" }); return store.get(path); },
      atomicWrite: async ({ path, content }) => store.set(path, content) }, assertInputs: async () => {} };
  return { options, store, commands, close: () => rm(projectRoot, { recursive: true, force: true }) };
}

test("a completed command survives a later crash and only the unfinished command reruns", async () => {
  const f = await fixture();
  try {
    const calls = [];
    const input = { commands: f.commands, context: {}, projectRoot: f.options.projectRoot, sourceRoot: f.options.projectRoot,
      safeOutput: String, projectLogger: () => {}, taskId: "T-RECEIPTS" };
    const first = await createTicketCommandReceipts(f.options);
    await assert.rejects(runTicketVerificationCommands({ ...input, commandReceipts: first,
      runCommand: async command => { calls.push(command.kind); if (command.kind === "backend_tests") throw Error("runner interrupted"); return { exit_code: 0, stdout: "PASS", stderr: "" }; } }), /runner interrupted/);
    assert.equal(f.store.size, 1);
    const second = await createTicketCommandReceipts({ ...f.options, job: { ...f.options.job, job_id: "VERIFY-2" } });
    const results = await runTicketVerificationCommands({ ...input, commandReceipts: second,
      runCommand: async command => { calls.push(command.kind); return { exit_code: 0, stdout: "PASS", stderr: "" }; } });
    assert.deepEqual(calls, ["lint", "backend_tests", "backend_tests"]);
    assert.equal(results[0].reused_from.job_id, "VERIFY-1");
    assert.equal(results[0].duration_ms, 0);
    assert.equal(results[1].exit_code, 0);
    assert.equal(results[1].reused_from, undefined);
  } finally { await f.close(); }
});

test("source, environment, dependency installation, runner and command plan invalidate PASS receipts", async () => {
  const f = await fixture();
  try {
    const command = f.commands[0];
    const cache = await createTicketCommandReceipts(f.options);
    await cache.save(command, { ...command, exit_code: 0 });
    assert.equal((await cache.load(command)).exit_code, 0);
    for (const patch of [
      { context: { review_commit_sha: "new-commit" } }, { checksums: { "source.js": "changed" } },
      { environment: { sha256: "new-environment" } }, { job: { ...f.options.job, runner_revision: "new-runner" } },
      { commands: [...f.commands, { kind: "test", argv: ["other-test"] }] }
    ]) assert.equal(await (await createTicketCommandReceipts({ ...f.options, ...patch })).load(command), null);
    await mkdir(join(f.options.projectRoot, "node_modules"));
    await writeFile(join(f.options.projectRoot, "node_modules/.modules.yaml"), "installed: changed\n");
    assert.equal(await (await createTicketCommandReceipts(f.options)).load(command), null);
    assert.equal(await cache.load(command), null);
  } finally { await f.close(); }
});

test("failed, tampered, source-mutating and external checks never supply a reusable PASS", async () => {
  const f = await fixture();
  try {
    const cache = await createTicketCommandReceipts(f.options);
    const command = f.commands[0];
    await cache.save(command, { ...command, exit_code: 1 });
    for (const external of [{ ...command, kind: "browser" }, { ...command, kind: "build" }, { ...command, environment: "filesystem_namespace" }]) {
      await cache.save(external, { ...external, exit_code: 0 });
      assert.equal(await cache.load(external), null);
    }
    assert.equal(f.store.size, 0);
    const invalid = await createTicketCommandReceipts({ ...f.options, assertInputs: async () => { throw Error("source mutated"); } });
    await assert.rejects(invalid.save(command, { ...command, exit_code: 0 }), /source mutated/);
    assert.equal(f.store.size, 0);
    await cache.save(command, { ...command, exit_code: 0 });
    const [path, content] = [...f.store.entries()][0];
    const receipt = JSON.parse(content);
    receipt.result.exit_code = 1;
    f.store.set(path, JSON.stringify(receipt));
    assert.equal(await cache.load(command), null);
    receipt.result.exit_code = 0;
    receipt.result.stdout_redacted = "altered evidence";
    f.store.set(path, JSON.stringify(receipt));
    assert.equal(await cache.load(command), null);
    f.store.set(path, "null");
    assert.equal(await cache.load(command), null);
  } finally { await f.close(); }
});
