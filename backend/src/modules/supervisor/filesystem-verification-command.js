// Routes checks requiring real filesystem denials into the isolated runner.
// Externally provisioned manifests retain the native execution path; unrelated
// checks keep their normal runner and never acquire container privileges.
import { fileURLToPath } from "node:url";

// Identifies the mandatory real-denial suite without routing unrelated tests.
export const FILESYSTEM_ENVIRONMENT_TEST = "backend/tests/integration/project-filesystem-environment.test.js";

// Preserves the verifier's exact argument vector and source snapshot while the
// container provisions fixtures and exports their manifest to its Node child.
export function filesystemVerificationCommand(argv, cwd, environment = process.env) {
  if (environment.NODEFORGE_FILESYSTEM_FIXTURES || !argv.includes(FILESYSTEM_ENVIRONMENT_TEST)) return argv;
  if (environment.NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET) {
    return [process.execPath, fileURLToPath(new URL("../../../scripts/verify-filesystem-namespace.mjs", import.meta.url)),
      "run", "--cwd", cwd, "--", ...argv];
  }
  return [process.execPath, fileURLToPath(new URL("../../../scripts/verify-filesystem-environment.mjs", import.meta.url)),
    "--cwd", cwd, "--", ...argv];
}
