// Diagnoses security-regression attribution for O3 by running unchanged assertions against current and baseline ticket sources in one captured environment.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { captureVerificationEnvironment } from "../../src/modules/supervisor/ticket/ticket-verification-environment.js";
import { materializeTicketVerification } from "../../src/modules/supervisor/ticket/ticket-verification-materialization.js";

// Uses argv-only subprocess execution to retain original test assertions and avoid shell or workspace mutations.
const execute = promisify(execFile);
// Fixes attribution to the ticket's recorded parent rather than whichever commit happens to be HEAD.
const baselineCommit = "8d477bbca1901c30cd93872d5a65c2dc45f8f6cd";
// Keeps the complete backend and schema dependency graph at each source revision.
// This prevents old lifecycle imports from binding to a newer, incompatible policy;
// assertions and installed dependencies remain identical in the captured environment.
async function securitySourcePaths(root) {
  const paths = new Set((await execute("git", ["ls-tree", "-r", "--name-only", baselineCommit, "--", "backend/src", "schemas"], { cwd: root })).stdout.trim().split("\n").filter(Boolean));
  for (const directory of ["backend/src", "schemas"]) {
    for (const entry of await readdir(resolve(root, directory), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) paths.add(resolve(entry.parentPath, entry.name).slice(root.length + 1));
    }
  }
  // The historical commit omitted this dependency and its current transitive import.
  // Capture their identical working-tree bytes as shared environment, not historical source.
  return [...paths].filter((path) => !["backend/src/tools/execution-file-access.js", "backend/src/infrastructure/filesystem/coder-project-access.js"].includes(path) && /\.(?:js|mjs|cjs|json)$/.test(path)).sort();
}

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
  const failures = [...output.stdout.matchAll(/not ok[^\n]*\n[\s\S]*?\n {2}\.\.\./g)].map(([block]) => block.replaceAll(root, "<source-root>").replace(/duration_ms: [^\n]+/g, "duration_ms: <timing>"));
  const source = await readFile(resolve(root, "backend/src/application/owner-sdk-stream.js"), "utf8");
  const assertions = await readFile(resolve(root, "backend/tests/unit/system-engineer-sdk-tools.test.js"));
  return { exit_code: output.exit_code, failures, gate: source.match(/const allowBuiltinWebSearch\s*=\s*[^;]+;/)?.[0], source_sha256: createHash("sha256").update(source).digest("hex"), assertions_sha256: createHash("sha256").update(assertions).digest("hex"), stderr: output.stderr, startup_diagnostics: output.stdout.split("\n").filter((line) => /^#.*(?:Error|Cannot|does not provide|ERR_)/.test(line)).slice(0,12) };
}

// Produces executable attribution evidence without granting acceptance, altering gates, or changing the live working tree.
test("O3 security assertions compare against the fixed baseline in the same environment", async () => {
  const root = resolve(new URL("../../../", import.meta.url).pathname);
  const repository = await execute("git", ["rev-parse", "--show-toplevel"], { cwd: root });
  const projectRoot = repository.stdout.trim();
  const referenceFiles = (await execute("git", ["ls-tree", "-r", "--name-only", baselineCommit, "--", "backend/src"], { cwd: projectRoot })).stdout.trim().split("\n");
  const referenceDiscovery = (await execute("git", ["show", `${baselineCommit}:backend/src/tools/rg-files.js`], { cwd: projectRoot })).stdout;
  const referenceIntegrity = { discovery_imports_execution_file_access: referenceDiscovery.includes("./execution-file-access.js"), execution_file_access_tracked: referenceFiles.includes("backend/src/tools/execution-file-access.js") };
  const ticketPaths = await securitySourcePaths(projectRoot);
  const environment = await captureVerificationEnvironment({ projectRoot, ticketPaths });
  const overlayFiles = Object.fromEntries(await Promise.all(ticketPaths.map(async (path) => {
    try { return [path, await readFile(resolve(root, path))]; }
    catch (error) { if (error.code === "ENOENT") return [path, null]; throw error; }
  })));
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
    console.log(JSON.stringify({ diagnostic_only: true, baseline_commit: baselineCommit, reference_integrity: referenceIntegrity, environment_sha256: environment.sha256, current, baseline: previous }));
    assert.equal(current.assertions_sha256, previous.assertions_sha256);
    assert.equal(current.exit_code, 0, JSON.stringify({ current, baseline: previous }));
    assert.deepEqual(current.failures, [], JSON.stringify({ current, baseline: previous }));
  } finally { await currentArchive?.cleanup(); await baseline.cleanup(); }
});
