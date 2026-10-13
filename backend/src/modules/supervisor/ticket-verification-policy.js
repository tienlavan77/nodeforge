// Prevents reuse of incomplete ticket artifacts, including reports missing approved real-browser checks.
import { requiresSchemaVerification } from "./ticket-verification-plan.js";
import { matchesBrowserEvidence } from "./browser-verification-evidence.js";

// Requires source-bound passing command receipts and every browser step in the current approved plan.
export function coversVerificationPolicy(artifact, paths, verificationPlan = []) {
  if (!["ticket-verification-v6", "ticket-verification-v5", "ticket-verification-v4", "ticket-verification-v3"].includes(artifact.policy_version) || !Array.isArray(artifact.planned_commands) || !Array.isArray(artifact.commands) || !artifact.planned_commands.length || artifact.commands.length !== artifact.planned_commands.length) return false;
  const required = new Set();
  if (paths.some((path) => path.startsWith("backend/"))) {
    required.add("typecheck"); required.add("backend_tests");
    if (paths.some((path) => /^backend\/.*\.[cm]?js$/.test(path))) required.add("lint");
  }
  if (requiresSchemaVerification(paths)) required.add("schema_validation");
  if (paths.some((path) => path.startsWith("ui/nextjs/"))) required.add("build");
  for (const [index, planned] of artifact.planned_commands.entries()) {
    const actual = artifact.commands[index];
    if (!planned?.kind || !Array.isArray(planned.argv) || !planned.argv.length || actual?.kind !== planned.kind || JSON.stringify(actual.argv) !== JSON.stringify(planned.argv) || actual.exit_code !== 0 || typeof actual.output_sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(actual.output_sha256)) return false;
    required.delete(planned.kind);
  }
  for (const step of verificationPlan.filter((entry) => entry.kind === "browser")) {
    if (!artifact.commands.some((command) => command.kind === "browser" && matchesBrowserEvidence(step, command.browser_evidence))) return false;
  }
  return required.size === 0;
}
