/** Exercises real subprocess output beyond the display budget so Node retains
 * complete failure evidence, redacts secrets and supplies only repair details. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { executeTicketVerificationCommand } from "../../src/modules/supervisor/ticket-verification-command.js";
import { collectVerificationFailures, redactVerificationText, createVerificationFailureCollector } from "../../src/modules/supervisor/ticket-verification-output.js";
import { regressionFailureIdentity } from "../../src/modules/supervisor/ticket-verification-regression.js";
import { verificationFailureCommands } from "../../src/modules/supervisor/ticket-verification-result.js";

test("URL redaction preserves JSON delimiters and masks credentials", () => {
  const line = JSON.stringify({ type: "output", text: "Listening http://127.0.0.1:3100\ntoken=example-password" });
  const result = JSON.parse(redactVerificationText(line));
  assert(!result.text.includes("127.0.0.1"));
  assert(!result.text.includes("example-password"));
  assert.match(result.text, /REDACTED/);
});

test("full-stream failures survive 64KB logging without sending PASS output to the agent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nf-verification-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "noisy.test.cjs");
  await writeFile(path, "const test=require('node:test');const assert=require('node:assert/strict');\nconsole.log('PASS-NOISE-'+ 'x'.repeat(90000));console.log('Listening http://127.0.0.1:3100');\ntest('success',()=>{});test('repair me',()=>assert.equal(1,2));\n");
  const reporter = new URL("../../src/modules/supervisor/ticket-verification-reporter.js", import.meta.url).pathname;
  const command = { kind: "backend_tests", scope: "ticket", test_paths: [path], argv: [process.execPath, "--test", `--test-reporter=${reporter}`, path] };
  const output = await executeTicketVerificationCommand({ ...command, cwd: root, environment: "project", timeoutMs: 10000 });
  assert.equal(output.exit_code, 1);
  assert.equal(output.stdout.length, 65536);
  assert(!output.stdout.includes('"type":"failure"'));
  assert.equal(output.failure_evidence.complete, true);
  const stdout_redacted = redactVerificationText(output.stdout), stderr_redacted = redactVerificationText(output.stderr);
  const receipt = { ...command, exit_code: output.exit_code, stdout_redacted, stderr_redacted,
    failure_evidence: { ...output.failure_evidence, visible_output_sha256: `sha256:${createHash("sha256").update(JSON.stringify([stdout_redacted, stderr_redacted])).digest("hex")}` } };
  assert.match(regressionFailureIdentity(command, receipt, root), /^sha256:[a-f0-9]{64}$/);
  const response = verificationFailureCommands([receipt]);
  assert.match(response[0].stdout_redacted, /repair me/);
  assert(!JSON.stringify(response).includes("PASS-NOISE"));
  assert.equal(regressionFailureIdentity(command, { ...receipt, stdout_redacted: "tampered" }, root), null);
});

test("partial, malformed and transient evidence never becomes a baseline exemption", () => {
  const failure = JSON.stringify({ type: "failure", name: "failed", error: { message: "assertion" } });
  const summary = JSON.stringify({ type: "summary", failed: 1, cancelled: 0 });
  assert.equal(collectVerificationFailures(failure, "").complete, false);
  assert.equal(collectVerificationFailures(`broken\n${failure}\n${summary}`, "").complete, false);
  assert.equal(collectVerificationFailures(`${failure}\n${summary}`, "ENOSPC").transient_failure, true);
  const collector = createVerificationFailureCollector();
  const bytes = Buffer.from(`${JSON.stringify({ type: "output", text: "Tiếng Việt" })}\n${failure}\n${summary}`);
  for (const byte of bytes) collector.write("stdout", Buffer.from([byte]));
  assert.equal(collector.finish().complete, true);
});
