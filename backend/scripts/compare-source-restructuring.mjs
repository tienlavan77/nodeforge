/**
 * Attributes focused source-restructuring failures to the exact pre-move snapshot
 * instead of assuming that a historical commit represents today's environment.
 * Both disposable trees receive the same dependency bytes. Only recorded B.2
 * source/import changes differ; path normalization leaves failure assertions intact.
 * This diagnostic does not grant acceptance or hide failing production checks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { captureVerificationEnvironment } from "../src/modules/supervisor/ticket/ticket-verification-environment.js";
import { materializeTicketVerification } from "../src/modules/supervisor/ticket/ticket-verification-materialization.js";

// Runs identical Node test commands without shell interpolation in isolated archives.
const execute = promisify(execFile);
// Fixes this diagnostic to the failed focused files, leaving their assertions unchanged.
let assertions = [
  "backend/tests/tools/git-read-tools.test.js",
  "backend/tests/unit/agent-line-budget-integration.test.js",
  "backend/tests/unit/coder-path-permissions.test.js",
  "backend/tests/unit/reviewer-discovery-tools.test.js",
  "backend/tests/unit/system-engineer-forge-storage.test.js",
  "backend/tests/unit/coder-unified-forge-tools.test.js",
  "backend/tests/unit/coder-reviewer-capabilities.test.js",
  "backend/tests/unit/coder-tool-quota.test.js",
  "backend/tests/unit/compatible-role-tools.test.js",
  "backend/tests/unit/owner-sdk-tools.test.js",
  "backend/tests/unit/agent-code-cache.test.js",
  "backend/tests/unit/blocker-dependency-evidence.test.js",
  "backend/tests/unit/browser-verification.test.js",
  "backend/tests/unit/claude-file-tools.test.js",
  "backend/tests/unit/dependency-agent-read.test.js",
  "backend/tests/unit/owner-engineer-tools.test.js",
  "backend/tests/integration/purpose-summary-search-compatibility.test.js"
];

// Normalizes only approved moved paths and archive locations, retaining diagnostic causes.
function normalize(text, root, changes) {
  let value = text.replaceAll(root, "<source-root>");
  for (const change of changes) if (change.path !== change.target) {
    value = value.replaceAll(change.target, change.path);
    value = value.replaceAll(change.target.replace(/^backend\//, ""), change.path.replace(/^backend\//, ""));
    value = value.replaceAll(change.target.replace(/^backend\/src\//, ""), change.path.replace(/^backend\/src\//, ""));
  }
  return value.replace(/duration_ms: [^\n]+/g, "duration_ms: <timing>");
}

// Retains full TAP failure blocks and normalized assertion hashes for both source trees.
async function evaluate(root, changes) {
  let result;
  try {
    result = { ...await execute(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...assertions],
      { cwd: root, timeout: 240_000, maxBuffer: 8_000_000,
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT")) }), exit_code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    result = { stdout: error.stdout, stderr: error.stderr, exit_code: error.code };
  }
  await writeFile(resolve(root, ".restructuring-test-output.json"), JSON.stringify(result) + "\n");
  assert.match(result.stdout, /# tests [1-9]\d*/, `Incomplete TAP output: ${result.stderr}; tail: ${result.stdout.slice(-3000)}`);
  const output = normalize(result.stdout, root, changes);
  const failures = [...output.matchAll(/not ok[^\n]*\n[\s\S]*?\n {2}\.\.\./g)].map(([block]) => block);
  assert.ok(result.exit_code === 0 || failures.length > 0, "A failed runner must retain TAP failures");
  const hashes = await Promise.all(assertions.map(async (path) => {
    const source = normalize(await readFile(resolve(root, path), "utf8"), root, changes);
    return { path, sha256: createHash("sha256").update(source).digest("hex") };
  }));
  return { exit_code: result.exit_code, failures, assertions: hashes, stderr: normalize(result.stderr, root, changes) };
}

// Proves attribution using checksum-validated pre-move bytes and identical surrounding dependencies.
test("Focused restructuring tests compare against exact pre-move source in the same environment", async () => {
  const root = resolve(new URL("../../", import.meta.url).pathname);
  // Selects the exact immediately preceding migration snapshot and focused tests for each approved B.3 group.
  let stage;
  try { stage = JSON.parse(await readFile(resolve(root, ".forge/runtime/reports/phase-b3-comparison-active.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (stage) assertions = stage.assertions;
  const changes = new Map();
  if (stage) {
    for (const path of stage.snapshots) {
      const snapshot = JSON.parse(await readFile(resolve(root, path), "utf8"));
      for (const change of snapshot.changes) changes.set(change.path, change);
    }
  } else {
  for (let part = 1; part <= 7; part++) {
    const snapshot = JSON.parse(await readFile(resolve(root, `.forge/runtime/reports/phase-b2-exact-before-0${part}.json`), "utf8"));
    for (const change of snapshot.changes) changes.set(change.path, change);
  }
  for (const name of ["policy", "access-test"]) {
    const amendment = JSON.parse(await readFile(resolve(root, `.forge/runtime/reports/phase-b2-concurrent-${name}-amendment.json`), "utf8"));
    changes.set(amendment.change.path, amendment.change);
  }
  }
  const records = [...changes.values()];
  for (const record of records) {
    assert.equal("sha256:" + createHash("sha256").update(record.before).digest("hex"), record.before_checksum, record.path);
  }
  const ticketPaths = [...new Set(records.flatMap(({ path, target }) => [path, target]))];
  const environment = await captureVerificationEnvironment({ projectRoot: root, ticketPaths });
  const commitSha = (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const beforeFiles = Object.fromEntries(ticketPaths.map((path) => [path, null]));
  const currentFiles = { ...beforeFiles };
  for (const record of records) beforeFiles[record.path] = record.before;
  for (const path of ticketPaths) {
    try { currentFiles[path] = await readFile(resolve(root, path)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const before = await materializeTicketVerification({ projectRoot: root, commitSha, ticketPaths, environment, overlayFiles: beforeFiles });
  let current;
  try {
    current = await materializeTicketVerification({ projectRoot: root, commitSha, ticketPaths, environment, overlayFiles: currentFiles });
    const previous = await evaluate(before.path, records);
    const after = await evaluate(current.path, records);
    await before.assertEnvironment(); await before.assertTicketSource();
    await current.assertEnvironment(); await current.assertTicketSource();
    const evidence = { purpose: "Diagnostic attribution only; failing focused gates remain failed.", environment_sha256: environment.sha256,
      source: stage?.name ?? "exact pre-B.2 snapshots with concurrent amendments", baseline: previous, current: after };
    await writeFile(resolve(root, stage?.evidence ?? ".forge/runtime/reports/phase-b2-failure-comparison.json"), JSON.stringify(evidence) + "\n");
    console.log(JSON.stringify({ environment_sha256: environment.sha256, baseline_failures: previous.failures.length, current_failures: after.failures.length }));
    assert.deepEqual(after.assertions, previous.assertions);
    // Node may include its internal scheduling frame in only one otherwise identical stack.
    // Retain both full blocks in evidence and compare every remaining diagnostic field.
    const schedulingFrame = /^ {4}process\.processTicksAndRejections \(node:internal\/process\/task_queues:\d+:\d+\)\n/gm;
    assert.deepEqual({ exit_code: after.exit_code, failures: after.failures.map((block) => block.replace(schedulingFrame, "")) },
      { exit_code: previous.exit_code, failures: previous.failures.map((block) => block.replace(schedulingFrame, "")) });
  } finally { await current?.cleanup(); await before.cleanup(); }
});
