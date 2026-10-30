// Exercises the production reporter with real Node assertion objects so large
// prompt failures retain complete structured receipts within the output budget.
// Baseline attribution must keep exact test locations and failed predicates,
// preserve infrastructure failures and reject malformed or truncated output.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import report from "../../src/modules/supervisor/ticket/ticket-verification-reporter.js";
import { regressionFailureIdentity } from "../../src/modules/supervisor/ticket/ticket-verification-regression.js";

// Runs the actual Node test reporter against several oversized prompt assertions,
// applying the same visible-output limit used by the verification command executor.
async function runPromptChecks(prefix) {
  const script = `const test=require('node:test');const assert=require('node:assert/strict');for(let n=0;n<4;n++)test('prompt '+n,()=>assert.match(${JSON.stringify(prefix)}+'x'.repeat(90000),/80 physical lines/i));`;
  const reporter = new URL("../../src/modules/supervisor/ticket/ticket-verification-reporter.js", import.meta.url).pathname;
  const root = await mkdtemp(join(tmpdir(), "verification-reporter-"));
  const path = join(root, "prompt.test.cjs");
  await writeFile(path, script);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  try { return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", `--test-reporter=${reporter}`, path], { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(0, 65536); });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", exit_code => resolve({ exit_code, stdout_redacted: stdout.split(root).join("<test-root>"), stderr_redacted: stderr }));
  }); } finally { await rm(root, { recursive: true, force: true }); }
}

// Validates real reporter framing and equivalent baseline/current predicates instead
// of checking implementation text or accepting a prebuilt synthetic success receipt.
test("oversized prompt assertions retain all failures and summary for baseline attribution", async () => {
  const baseline = await runPromptChecks("baseline ");
  const current = await runPromptChecks("current ");
  assert.equal(current.exit_code, 1, current.stderr_redacted);
  const entries = current.stdout_redacted.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries.filter(entry => entry.type === "failure").length, 4);
  assert.equal(entries.at(-1).type, "summary");
  assert.equal(entries.at(-1).failed, 4);
  assert.ok(Buffer.byteLength(current.stdout_redacted) < 10000);
  const command = { test_paths: ["prompt.test.js"] };
  const identity = regressionFailureIdentity(command, current, process.cwd());
  assert.match(identity, /^sha256:[a-f0-9]{64}$/);
  assert.equal(identity, regressionFailureIdentity(command, baseline, process.cwd()));
});

// Infrastructure diagnostics cannot become pre-existing assertion evidence merely
// because the visible failure happened inside a string-to-regex check.
test("infrastructure errors retain their original diagnostics and remain unattributed", async () => {
  let error;
  try { assert.match("ENOSPC no space left on device", /80 physical lines/); }
  catch (caught) { error = caught; }
  // Supplies Node test events without executing privileged filesystem setup.
  async function* events() {
    yield { type: "test:fail", data: { name: "storage", file: "/tmp/test.js", line: 1, column: 1, details: { error } } };
    yield { type: "test:summary", data: { counts: { failed: 1, cancelled: 0 } } };
  }
  let stdout_redacted = "";
  for await (const chunk of report(events())) stdout_redacted += chunk;
  assert.match(stdout_redacted, /ENOSPC/);
  assert.equal(regressionFailureIdentity({ test_paths: ["test.js"] }, { exit_code: 1, stdout_redacted }, "/tmp"), null);
});
