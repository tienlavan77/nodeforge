import { spawn } from "node:child_process";

import { ConfigurationError } from "../../shared/errors.js";

export function createProjectCommandExecutor({ projectRoot, spawnProcess = spawn } = {}) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0 || typeof spawnProcess !== "function") {
    throw new ConfigurationError("A project root and spawn function are required for verification commands.");
  }

  return (command) => new Promise((resolve, reject) => {
    const environment = { ...process.env };
    // Node's test-worker marker would make a child `node --test` skip project tests.
    delete environment.NODE_TEST_CONTEXT;
    // Keep shell tools such as ESLint from resolving diagnostics against Forge's own cwd.
    environment.PWD = projectRoot;
    const child = spawnProcess(command, { cwd: projectRoot, env: environment, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    if (!child?.stdout || !child?.stderr) {
      reject(new ConfigurationError("Verification commands must expose stdout and stderr streams."));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    // `close` runs only after stdout and stderr close, so diagnostic output is complete.
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
