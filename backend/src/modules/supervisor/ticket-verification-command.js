// Executes verification commands without a shell. Explicit environment requests
// are fulfilled by Node and return runner receipts alongside bounded test output.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { filesystemVerificationCommand } from "./filesystem-verification-command.js";
import { runFilesystemNamespace } from "./filesystem-namespace-runner.js";
import { assertVerificationRunnerEnvironment } from "./verification-runner-environment.js";
import { createVerificationFailureCollector } from "./ticket-verification-output.js";

// Preserves the command's exact source cwd and full-stream output digests while
// keeping fixture provisioning separate from ordinary project subprocesses.
export async function executeTicketVerificationCommand({ argv, cwd, tempDir, timeoutMs, signal, environment, projectRoot }) {
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
  let result;
  if (environment === "filesystem_namespace") {
    if (!projectRoot) throw new Error("Filesystem verification requires its Node-bound project root.");
    const command = argv[0] === "node" ? [process.execPath, ...argv.slice(1)] : argv;
    if (command[0] !== process.execPath) throw Object.assign(new Error("Filesystem namespace verification requires a Node command."), { code: "VERIFY_ENVIRONMENT_INVALID" });
    result = await runFilesystemNamespace({ projectRoot, argv: command, cwd, timeoutMs, signal, onOutput });
  } else {
    result = await new Promise((resolve, reject) => {
      const env = { ...process.env, PWD: cwd, ...(tempDir ? { TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir } : {}) };
      delete env.NODE_TEST_CONTEXT;
      const launch = environment === "project" ? argv : filesystemVerificationCommand(argv, cwd, env);
      const child = spawn(launch[0], launch.slice(1), { cwd, env, signal, stdio: ["ignore", "pipe", "pipe"] });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => onOutput("stdout", chunk)); child.stderr.on("data", chunk => onOutput("stderr", chunk));
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); resolve({ exit_code: timedOut ? null : code }); });
    });
  }
  return { ...result, stdout, stderr, ...(failures ? { failure_evidence: failures.finish() } : {}), output_sha256: `sha256:${createHash("sha256").update(`${stdoutHash.digest("hex")}\0${stderrHash.digest("hex")}`).digest("hex")}` };
}
