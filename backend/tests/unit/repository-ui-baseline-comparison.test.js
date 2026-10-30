// Compares unchanged failing UI assertions against a fixed reference commit and
// current UI source in one captured environment. This diagnostic retains startup
// failures and distinct assertion causes instead of declaring nonzero exits to be
// pre-existing regressions; equality alone never grants Phase A acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { captureVerificationEnvironment } from "../../src/modules/supervisor/ticket/ticket-verification-environment.js";
import { materializeTicketVerification } from "../../src/modules/supervisor/ticket/ticket-verification-materialization.js";

const execute = promisify(execFile);
const baselineCommit = "8d477bbca1901c30cd93872d5a65c2dc45f8f6cd";
const assertions = [
  "ui/nextjs/tests/conversation-draft.test.js",
  "ui/nextjs/tests/conversations-navigation.test.js",
  "ui/nextjs/tests/multi-project-request-context.test.mjs",
  "ui/nextjs/tests/settings-segmented-controls.test.js",
  "ui/nextjs/tests/coding-workspace-layout-browser.test.js"
];

// Enumerates UI implementation inputs separately from the unchanged assertions
// and dependencies so both source variants receive the same captured environment.
async function uiSourcePaths(root) {
  const paths = [];
  for (const directory of ["app", "components", "lib"]) {
    const base = resolve(root, "ui/nextjs", directory);
    for (const entry of await readdir(base, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.(?:js|jsx|mjs|css|json)$/.test(entry.name)) paths.push(relative(root, resolve(entry.parentPath, entry.name)));
    }
  }
  return paths.sort();
}

// Preserves failure identity and startup diagnostics from the real assertion
// files while normalizing only archive location and timing for comparison.
async function evaluateUi(root) {
  let result;
  try {
    result = { ...await execute(process.execPath, ["--test", "--test-reporter=tap", ...assertions], {
      cwd: root, timeout: 60_000, maxBuffer: 4_000_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT"))
    }), exit_code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    result = { exit_code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  assert.match(result.stdout, /# tests [1-9]\d*/);
  const failures = [...result.stdout.matchAll(/not ok[^\n]*\n[\s\S]*?\n {2}\.\.\./g)]
    .map(([block]) => block.replaceAll(root, "<source-root>").replace(/duration_ms: [^\n]+/g, "duration_ms: <timing>"));
  const assertionHashes = await Promise.all(assertions.map(async (path) => ({
    path, sha256: createHash("sha256").update(await readFile(resolve(root, path))).digest("hex")
  })));
  return { exit_code: result.exit_code, failures, assertions: assertionHashes, stderr: result.stderr.replaceAll(root, "<source-root>") };
}

test("diagnostic UI failures compare unchanged assertions against the fixed reference in the same environment", async () => {
  const root = resolve(new URL("../../../", import.meta.url).pathname);
  const ticketPaths = await uiSourcePaths(root);
  const environment = await captureVerificationEnvironment({ projectRoot: root, ticketPaths });
  const overlayFiles = Object.fromEntries(await Promise.all(ticketPaths.map(async (path) => [path, await readFile(resolve(root, path))])));
  const baseline = await materializeTicketVerification({ projectRoot: root, commitSha: baselineCommit, ticketPaths, environment });
  let currentArchive;
  try {
    currentArchive = await materializeTicketVerification({ projectRoot: root, commitSha: baselineCommit, ticketPaths, environment, overlayFiles });
    const current = await evaluateUi(currentArchive.path);
    const previous = await evaluateUi(baseline.path);
    await baseline.assertEnvironment();
    await baseline.assertTicketSource();
    await currentArchive.assertEnvironment();
    await currentArchive.assertTicketSource();
    assert.deepEqual(current.assertions, previous.assertions);
    assert.deepEqual({ exit_code: current.exit_code, failures: current.failures }, { exit_code: previous.exit_code, failures: previous.failures },
      JSON.stringify({ diagnostic_only: true, baseline_commit: baselineCommit, environment_sha256: environment.sha256,
        current_stderr: current.stderr, baseline_stderr: previous.stderr,
        current_failures: current.failures.map((block) => block.split("\n")[0]),
        baseline_failures: previous.failures.map((block) => block.split("\n")[0]),
        matching_failures: current.failures.filter((block) => previous.failures.includes(block)).map((block) => block.split("\n")[0]),
        reason: "Different causes or baseline startup failure cannot establish a pre-existing UI regression." }));
  } finally {
    await currentArchive?.cleanup();
    await baseline.cleanup();
  }
});
