// Executes verification commands without a shell. Explicit environment requests
// are fulfilled by Node and return runner receipts alongside bounded test output.
import { createHash } from "node:crypto";
import { executeWithVerificationEnvironmentSeam } from "../verification-environment-seam.js";
import { assertVerificationRunnerEnvironment } from "../verification-runner-environment.js";
import { createVerificationFailureCollector } from "./ticket-verification-output.js";

// Preserves the command's exact source cwd and full-stream output digests while
// keeping fixture provisioning separate from ordinary project subprocesses.
export async function executeTicketVerificationCommand({ argv, cwd, tempDir, outputDirs, timeoutMs, signal, environment, projectRoot, sandbox, bwrapPath, spawnImpl }) {
  assertVerificationRunnerEnvironment(environment);
  signal?.throwIfAborted();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdout = "";
  let stderr = "";
  const failures = argv.some(arg => arg.includes("--test-reporter=") && arg.includes("ticket-verification-reporter.js")) ? createVerificationFailureCollector() : null;
  // Bounds visible output without truncating the bytes included in its digest.
  function onOutput(stream, data) {
    failures?.write(stream, data);
    if (stream === "stdout") { stdoutHash.update(data); stdout = (stdout + data).slice(0, 65536); }
    else if (stream === "stderr") { stderrHash.update(data); stderr = (stderr + data).slice(0, 65536); }
  }
  const result = await executeWithVerificationEnvironmentSeam({
    argv, cwd, tempDir, outputDirs, timeoutMs, signal, environment, projectRoot, onOutput, sandbox, bwrapPath, spawnImpl
  });
  return { ...result, stdout, stderr, ...(failures ? { failure_evidence: failures.finish() } : {}), output_sha256: `sha256:${createHash("sha256").update(`${stdoutHash.digest("hex")}\0${stderrHash.digest("hex")}`).digest("hex")}` };
}
