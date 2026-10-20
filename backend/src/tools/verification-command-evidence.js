// Matches approved verification steps to immutable command receipts without relying on Coder claims.
import { matchesBrowserEvidence } from "../modules/supervisor/browser-verification-evidence.js";

// Recognizes a focused backend test inside Node's grouped backend run while preserving exact test paths and browser assertions.
export function findPassingVerificationCommand(step, commands) {
  return commands.find((command) => {
    const kind = step.kind ?? step.command_kind;
    const matchesKind = command.kind === kind || kind === "test" && command.kind === "backend_tests";
    return matchesKind && command.exit_code === 0
      && (!step.test_path || command.argv?.includes(step.test_path))
      && (kind !== "browser" || matchesBrowserEvidence(step, command.browser_evidence));
  });
}
