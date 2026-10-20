// Prevents reuse of incomplete ticket artifacts, including reports missing approved real-browser checks.
import { verificationCommandAccepted } from "./ticket-verification-regression.js";
import { requiresSchemaVerification } from "./ticket-verification-plan.js";
import { matchesBrowserEvidence } from "./browser-verification-evidence.js";

// Requires source-bound passing command receipts and every browser step in the current approved plan.
export function coversVerificationPolicy(artifact, paths, verificationPlan = []) {
  if (!["ticket-verification-v8", "ticket-verification-v7", "ticket-verification-v6", "ticket-verification-v5", "ticket-verification-v4", "ticket-verification-v3"].includes(artifact.policy_version) || !Array.isArray(artifact.planned_commands) || !Array.isArray(artifact.commands) || !artifact.planned_commands.length || artifact.commands.length !== artifact.planned_commands.length) return false;
  const required = new Set();
  if (paths.some((path) => path.startsWith("backend/"))) {
    required.add("backend_tests");
    const sourcePaths = ["ticket-verification-v8", "ticket-verification-v7"].includes(artifact.policy_version) ? paths.filter((path) => artifact.file_checksums?.[path] !== null) : paths;
    if (!["ticket-verification-v8", "ticket-verification-v7"].includes(artifact.policy_version) || sourcePaths.some((path) => /^backend\/.*\.[cm]?[jt]sx?$/.test(path))) required.add("typecheck");
    if (sourcePaths.some((path) => /^backend\/.*\.[cm]?js$/.test(path))) required.add("lint");
  }
  if (requiresSchemaVerification(paths)) required.add("schema_validation");
  if (paths.some((path) => path.startsWith("ui/nextjs/"))) required.add("build");
  if (artifact.policy_version === "ticket-verification-v8" && paths.some((path) => path.startsWith("backend/"))
    && !artifact.commands.some((command) => command.kind === "backend_tests" && command.scope === "ticket" && command.exit_code === 0)) return false;
  for (const [index, planned] of artifact.planned_commands.entries()) {
    const actual = artifact.commands[index];
    if (!planned?.kind || !Array.isArray(planned.argv) || !planned.argv.length || actual?.kind !== planned.kind || JSON.stringify(actual.argv) !== JSON.stringify(planned.argv) || (artifact.policy_version === "ticket-verification-v8" ? !verificationCommandAccepted(actual) : actual.exit_code !== 0) || typeof actual.output_sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(actual.output_sha256)) return false;
    if (artifact.policy_version === "ticket-verification-v8") {
      if (actual.scope !== planned.scope || JSON.stringify(actual.test_paths) !== JSON.stringify(planned.test_paths) || JSON.stringify(actual.criterion_ids) !== JSON.stringify(planned.criterion_ids)) return false;
      if (actual.exit_code !== 0 && (planned.scope !== "regression" || actual.baseline?.commit_sha !== artifact.base_sha || actual.baseline?.environment_sha256 !== (artifact.environment?.sha256 ?? actual.environment_sha256))) return false;
      if (actual.exit_code !== 0 && !artifact.environment && (actual.reproduction?.commit_sha !== artifact.commit_sha || actual.reproduction?.environment_sha256 !== actual.baseline?.environment_sha256 || actual.reproduction?.failure_sha256 !== actual.failure_sha256)) return false;
    }
    required.delete(planned.kind);
  }
  for (const step of verificationPlan.filter((entry) => entry.kind === "test")) {
    if (!artifact.commands.some((command) => command.exit_code === 0 && command.argv.includes(step.test_path) && (artifact.policy_version !== "ticket-verification-v8" || command.scope === "ticket"))) return false;
  }
  for (const step of verificationPlan.filter((entry) => entry.kind === "browser")) {
    if (!artifact.commands.some((command) => command.kind === "browser" && matchesBrowserEvidence(step, command.browser_evidence))) return false;
  }
  return required.size === 0;
}
