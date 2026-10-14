// Allows bounded verification retries after Node-owned browser tooling changes without rewriting finished ticket code.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const RUNNER_FILES = [
  "../../../scripts/verify-ticket-browser.mjs",
  "./browser-verification-runner.js",
  "./browser-verification-evidence.js",
  "./browser-coding-contract.js",
  "./browser-coding-scenarios.js",
  "./browser-coding-lifecycle-scenarios.js",
  "./browser-coding-fixture.js"
];

// Identifies the actual external browser runner and Node runtime separately from the immutable ticket revision.
export async function ticketVerificationRunnerRevision(verificationPlan, { readSource = readFile } = {}) {
  if (!verificationPlan?.some((step) => step?.kind === "browser")) return null;
  const hash = createHash("sha256").update(process.version);
  for (const path of RUNNER_FILES) {
    const content = await readSource(new URL(path, import.meta.url));
    hash.update(`\0${path}\0`).update(content);
  }
  return `sha256:${hash.digest("hex")}`;
}
