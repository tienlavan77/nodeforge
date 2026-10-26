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
const VERIFICATION_FILES = ["./ticket-verification-plan.js", "./ticket-verification-policy.js", "./ticket-verification-regression.js", "./ticket-verification-reporter.js", "./verification-failure-identity.js", "./ticket-archive-materialization.js"];
// Includes fixture infrastructure in retry identity only for checks that need
// real filesystem denials, so infrastructure repair can unlock a bounded retry.
const FILESYSTEM_RUNNER_FILES = ["./filesystem-verification-command.js", "../../../scripts/verify-filesystem-environment.mjs",
  "../../../scripts/verify-filesystem-namespace.mjs", "../../../test-environments/filesystem/namespace-fixtures.mjs",
  "../../../test-environments/filesystem/namespace-launch.mjs",
  "../../../test-environments/filesystem/namespace-bwrap.mjs",
  "../../../test-environments/filesystem/namespace-diagnostics.mjs",
  "../../../test-environments/filesystem/namespace-server.mjs", "../../../test-environments/filesystem/namespace-request.mjs",
  "../../../test-environments/filesystem/Dockerfile", "../../../test-environments/filesystem/provision.mjs"];

// Identifies the actual external browser runner and Node runtime separately from the immutable ticket revision.
export async function ticketVerificationRunnerRevision(verificationPlan, { readSource = readFile } = {}) {
  const hash = createHash("sha256").update(process.version);
  const paths = [...VERIFICATION_FILES, ...(verificationPlan?.some((step) => step?.kind === "browser") ? RUNNER_FILES : [])];
  if (verificationPlan?.some(step => step?.test_path === "backend/tests/integration/project-filesystem-environment.test.js")) {
    paths.push(...FILESYSTEM_RUNNER_FILES);
    hash.update(process.env.NODEFORGE_FILESYSTEM_CONTAINER_IMAGE ?? "nodeforge-filesystem-fixtures:node26");
    hash.update(`\0namespace:${process.env.NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET ?? ""}`);
  }
  for (const path of paths) {
    const content = await readSource(new URL(path, import.meta.url));
    hash.update(`\0${path}\0`).update(content);
  }
  return `sha256:${hash.digest("hex")}`;
}
