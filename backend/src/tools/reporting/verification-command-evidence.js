// Matches approved verification steps to immutable command receipts without relying on Coder claims.
import { matchesBrowserEvidence } from "../../modules/supervisor/browser/browser-verification-evidence.js";

// Recognizes a focused backend test inside Node's grouped backend run while preserving exact test paths and browser assertions.
export function findPassingVerificationCommand(step, commands) {
  return commands.find((command) => {
    const kind = step.kind ?? step.command_kind;
    const matchesKind = command.kind === kind || kind === "test" && command.kind === "backend_tests";
    return matchesKind && command.exit_code === 0
      && matchesTestScope(step, command, kind)
      && (kind !== "browser" || matchesBrowserEvidence(step, command.browser_evidence));
  });
}

/** Accepts grouped ticket tests only when Node recorded both their executed
 * paths and their acceptance bindings. This lets aggregate plan checks reuse
 * focused verification without accepting an unrelated passing project suite.
 * Exact-path legacy checks continue to require that path in the command. */
function matchesTestScope(step, command, kind) {
  if (step.test_path) return command.argv?.includes(step.test_path);
  if (!["test", "backend_tests"].includes(kind)) return true;
  return command.scope === "ticket"
    && Array.isArray(step.criterion_ids) && step.criterion_ids.length > 0
    && step.criterion_ids.every((id) => command.criterion_ids?.includes(id))
    && Array.isArray(command.test_paths) && command.test_paths.length > 0
    && command.test_paths.every((path) => typeof path === "string" && path.length > 0 && command.argv?.includes(path));
}
