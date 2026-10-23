// Diagnoses security-regression attribution for O3 by running unchanged assertions against current and baseline ticket sources in one captured environment.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { captureVerificationEnvironment } from "../../src/modules/supervisor/ticket-verification-environment.js";
import { materializeTicketVerification } from "../../src/modules/supervisor/ticket-verification-materialization.js";

// Uses argv-only subprocess execution to retain original test assertions and avoid shell or workspace mutations.
const execute = promisify(execFile);
// Fixes attribution to the ticket's recorded parent rather than whichever commit happens to be HEAD.
const baselineCommit = "8d477bbca1901c30cd93872d5a65c2dc45f8f6cd";
// Keeps baseline ticket bytes separate from the shared non-ticket environment, including the unchanged security assertions.
const ticketPaths = [
  "backend/src/application/owner-sdk-stream.js", "backend/src/application/sprint-plan-leader.js", "backend/src/application/ticket-sprint-leader.js",
  "backend/src/modules/supervisor/committed-review-window.js", "backend/src/modules/supervisor/nodeforge-task-prompts.js", "backend/src/modules/supervisor/reviewer-forge-tools.js",
  "backend/src/tools/agent-lifecycle-tools.js", "backend/src/tools/index.js", "backend/src/tools/sed-lines.js", "backend/src/tools/sprint-leader-forge-tools.js",
  "backend/tests/unit/agent-discovery-read-window.test.js", "backend/tests/unit/agent-line-budget-integration.test.js", "backend/tests/unit/sprint-leader-forge-tools.test.js",
  "backend/tests/tools/sed-lines.test.js", "backend/tests/unit/owner-sdk-tools.test.js", "schemas/agent/tools/read-file.schema.json",
  "backend/tests/unit/agent-discovery-baseline-comparison.test.js"
];

// Captures original TAP failure blocks and hashes without treating a nonzero exit code alone as equivalent behavior.
async function securityResult(root) {
  let output;
  try { output = { ...await execute(process.execPath, ["--test", "--test-reporter=tap", "backend/tests/unit/system-engineer-sdk-tools.test.js"], { cwd: root, timeout: 60_000, maxBuffer: 2_000_000, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT")) }), exit_code: 0 }; }
  catch (error) {
    if (typeof error.code !== "number") throw error;
    output = { exit_code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  assert.match(output.stdout, /# tests [1-9]\d*/);
  assert.doesNotMatch(output.stderr, /skipping running files/);
  const failures = [...output.stdout.matchAll(/not ok[^\n]*\n[\s\S]*?\n  \.\.\./g)].map(([block]) => block.replaceAll(root, "<source-root>").replace(/duration_ms: [^\n]+/g, "duration_ms: <timing>"));
  const source = await readFile(resolve(root, "backend/src/application/owner-sdk-stream.js"), "utf8");
  const assertions = await readFile(resolve(root, "backend/tests/unit/system-engineer-sdk-tools.test.js"));
  return { exit_code: output.exit_code, failures, gate: source.match(/const allowBuiltinWebSearch\s*=\s*[^;]+;/)?.[0], source_sha256: createHash("sha256").update(source).digest("hex"), assertions_sha256: createHash("sha256").update(assertions).digest("hex"), stderr: output.stderr };
}

// Produces executable attribution evidence without granting acceptance, altering gates, or changing the live working tree.
test("O3 security assertions compare against the fixed baseline in the same environment", async () => {
  const root = resolve(new URL("../../..", import.meta.url).pathname);
  const repository = await execute("git", ["rev-parse", "--show-toplevel"], { cwd: root });
  const projectRoot = repository.stdout.trim();
  const environment = await captureVerificationEnvironment({ projectRoot, ticketPaths });
  const overlayFiles = Object.fromEntries(await Promise.all(ticketPaths.map(async (path) => [path, await readFile(resolve(root, path), "utf8")])));
  const baseline = await materializeTicketVerification({ projectRoot, commitSha: baselineCommit, ticketPaths, environment });
  let currentArchive;
  try {
    currentArchive = await materializeTicketVerification({ projectRoot, commitSha: baselineCommit, ticketPaths, environment, overlayFiles });
    const current = await securityResult(currentArchive.path);
    const previous = await securityResult(baseline.path);
    await baseline.assertEnvironment();
    await baseline.assertTicketSource();
    await currentArchive.assertEnvironment();
    await currentArchive.assertTicketSource();
    console.log(JSON.stringify({ diagnostic_only: true, baseline_commit: baselineCommit, environment_sha256: environment.sha256, current, baseline: previous }));
    assert.equal(current.assertions_sha256, previous.assertions_sha256);
    assert.deepEqual({ exit_code: current.exit_code, failures: current.failures }, { exit_code: previous.exit_code, failures: previous.failures }, "Different assertion causes require reconciliation; this diagnostic never waives backend regression checks.");
  } finally { await currentArchive?.cleanup(); await baseline.cleanup(); }
});
