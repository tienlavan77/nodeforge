// Verifies focused Coder checks persist commit-bound receipts without granting final acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { createTicketFocusedCheck } from "../../src/modules/supervisor/ticket-focused-check.js";

// Models Node services while capturing identity, source selection and immutable receipt writes.
function fixture() {
  const context = { version: 3, source_revision: "revision-3", review_commit_sha: "a".repeat(40), manifest_paths: ["backend/tests/unit/example.test.js"], state: "committed" };
  const writes = [];
  const calls = [];
  let cleanups = 0;
  const options = { taskId: "T", projectRoot: "/repo", executionContexts: { load: async () => structuredClone(context) },
    stateFileService: { atomicWrite: async (input) => writes.push(input) }, assertIdentity: async () => ({ "backend/tests/unit/example.test.js": "sha256:source" }),
    assertArchiveSource: async () => {}, safeOutput: (text) => text,
    captureEnvironment: async () => ({ files: [], manifest: [], sha256: "fixture" }),
    materialize: async (input) => { calls.push(input); return { path: "/archive", temp_dir: "/archive/tmp", cleanup: async () => { cleanups += 1; } }; },
    runCommand: async (input) => { calls.push(input); return { exit_code: 0, stdout: "passed", stderr: "", output_sha256: "sha256:output" }; }
  };
  return { context, writes, calls, options, cleanupCount: () => cleanups };
}

test("focused check returns its final result and persists evidence for the exact commit without approval", async () => {
  const { options, writes, calls, context, cleanupCount } = fixture();
  const result = await createTicketFocusedCheck(options)({ type: "test", command: "node --test backend/tests/unit/example.test.js" });
  assert.equal(result.status, "passed");
  assert.equal(result.commit_sha, context.review_commit_sha);
  assert.deepEqual(calls[1].argv, ["node", "--test", "backend/tests/unit/example.test.js"]);
  assert.equal(calls[1].cwd, "/archive");
  assert.equal(writes[0].replace, false);
  assert.equal(JSON.parse(writes[0].content).source_revision, "revision-3");
  assert.equal(context.state, "committed");
  assert.equal(cleanupCount(), 1);
});

test("invalid and uncommitted checks never start a command or write a receipt", async () => {
  const { options, context, writes, calls } = fixture();
  const run = createTicketFocusedCheck(options);
  for (const command of ["node --test", "node --test x; rm -rf .", "bash x.sh"]) await assert.rejects(run({ type: "test", command }));
  context.review_commit_sha = null;
  await assert.rejects(run({ type: "test", command: "node --test backend/tests/unit/example.test.js" }), { code: "TICKET_COMMIT_REQUIRED" });
  assert.equal(calls.length, 0);
  assert.equal(writes.length, 0);
});

test("stale or cancelled checks never persist a passed receipt and always clean the archive", async () => {
  const { options, context, writes, cleanupCount } = fixture();
  options.runCommand = async () => { context.version += 1; return { exit_code: 0 }; };
  await assert.rejects(createTicketFocusedCheck(options)({ type: "test", command: "node --test backend/tests/unit/example.test.js" }), { code: "VERIFY_CONTEXT_STALE" });
  const controller = new AbortController();
  options.runCommand = async () => { controller.abort(new Error("cancelled")); return { exit_code: 0 }; };
  await assert.rejects(createTicketFocusedCheck(options)({ type: "test", command: "node --test backend/tests/unit/example.test.js", signal: controller.signal }), /cancelled/);
  assert.equal(writes.length, 0);
  assert.equal(cleanupCount(), 2);
});

test("failed checks return failed receipts rather than final acceptance", async () => {
  const { options, writes } = fixture();
  options.runCommand = async () => ({ exit_code: 1, stdout: "", stderr: "assertion failed", output_sha256: "sha256:failure" });
  const receipt = await createTicketFocusedCheck(options)({ type: "test", command: "node --test backend/tests/unit/example.test.js" });
  assert.equal(receipt.status, "failed");
  assert.equal(JSON.parse(writes[0].content).exit_code, 1);
});
