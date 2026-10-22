// Allows bounded verification retries after Node-owned browser tooling changes without rewriting finished ticket code.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const RUNNER_FILES = [
  "../../../scripts/verify-ticket-browser.mjs",
  "./browser-verification-runner.js",
  "./browser-project-scenario.js", "./browser-coding-layout-fixture.js", "./browser-coding-layout-scenarios.js",
  "./browser-verification-evidence.js",
  "./browser-coding-contract.js",
  "./browser-coding-scenarios.js",
  "./browser-coding-lifecycle-scenarios.js",
  "./browser-coding-fixture.js",
  "./browser-coding-bundle.js", "./browser-coding-presence-fixture.js",
  "./browser-coding-presence-adapters.js", "./browser-coding-presence-scenarios.js"
];
const VERIFICATION_FILES = ["./ticket-verification-plan.js", "./ticket-verification-policy.js", "./ticket-verification-regression.js", "./ticket-verification-reporter.js", "./verification-failure-identity.js"];

// Identifies the actual external browser runner and Node runtime separately from the immutable ticket revision.
export async function ticketVerificationRunnerRevision(verificationPlan, { readSource = readFile } = {}) {
  const hash = createHash("sha256").update(process.version);
  const paths = [...VERIFICATION_FILES, ...(verificationPlan?.some((step) => step?.kind === "browser") ? RUNNER_FILES : [])];
  for (const path of paths) {
    const content = await readSource(new URL(path, import.meta.url));
    hash.update(`\0${path}\0`).update(content);
  }
  return `sha256:${hash.digest("hex")}`;
}
