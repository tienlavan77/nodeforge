// Binds real browser assertion receipts to every viewport in the approved immutable verification step.
import { createHash } from "node:crypto";

// Identifies the exact browser check without trusting a Coder-supplied coverage claim.
export function browserStepSha(step) {
  return `sha256:${createHash("sha256").update(JSON.stringify(step)).digest("hex")}`;
}

// Requires successful assertions at every approved viewport and a real browser version receipt.
export function matchesBrowserEvidence(step, evidence) {
  return Boolean(step?.kind === "browser" && Array.isArray(step.assertions) && step.assertions.length && Array.isArray(step.viewports) && step.viewports.length
    && evidence?.step_sha256 === browserStepSha(step) && typeof evidence.browser_version === "string" && evidence.browser_version.length
    && Array.isArray(evidence.results) && evidence.results.length === step.viewports.length
    && step.viewports.every((width, index) => evidence.results[index]?.viewport === width && evidence.results[index]?.passed === true && JSON.stringify(evidence.results[index]?.assertions) === JSON.stringify(step.assertions)));
}

// Rejects a zero-exit browser process that did not actually report the approved checks.
export function browserCommandOutput(command, output) {
  if (command.kind !== "browser" || output.exit_code !== 0) return output;
  try {
    const evidence = JSON.parse(output.stdout.trim());
    if (!matchesBrowserEvidence(command.browser_step, evidence)) throw new Error("Browser receipt does not cover the approved assertions and viewports.");
    return { ...output, browser_evidence: evidence };
  } catch (error) {
    return { ...output, exit_code: 1, stderr: `${output.stderr ?? ""}\nVERIFY_BROWSER_EVIDENCE_INVALID: ${error.message}` };
  }
}
