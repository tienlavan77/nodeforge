// Verifies browser runner repairs unlock bounded retries without requiring unrelated ticket code changes.
import assert from "node:assert/strict";
import test from "node:test";
import { ticketVerificationRunnerRevision } from "../../src/modules/supervisor/ticket/ticket-verification-runner-revision.js";

const plan = [{ kind: "browser" }];

// Keeps non-browser retry accounting compatible with durable legacy receipts.
test("non-browser verification does not fingerprint external browser tooling", async () => {
  const paths = [];
  const original = await ticketVerificationRunnerRevision([], { readSource: async (url) => { paths.push(url.pathname); return "original"; } });
  assert(paths.some((path) => path.endsWith("ticket-verification-reporter.js")));
  assert(!paths.some((path) => path.includes("browser")));
  assert.notEqual(await ticketVerificationRunnerRevision([], { readSource: async () => "repaired" }), original);
});

// Distinguishes each external runner repair while stable tooling retains the same retry identity.
test("browser runner revision changes for every runner dependency", async () => {
  const paths = [];
  const original = await ticketVerificationRunnerRevision(plan, { readSource: async (url) => { paths.push(url.pathname); return "original"; } });
  assert.equal(paths.length, 25);
  assert.ok(paths.some((path) => path.endsWith("ticket-verification-command-receipts.js")));
  assert.ok(paths.some((path) => path.endsWith("ticket-baseline-recovery.js")));
  assert.ok(paths.some((path) => path.endsWith("ticket-verification-output.js")));
  assert.ok(paths.some((path) => path.endsWith("browser-coding-presence-scenarios.js")));
  assert.equal(await ticketVerificationRunnerRevision(plan, { readSource: async () => "original" }), original);
  for (const path of paths) {
    assert.notEqual(await ticketVerificationRunnerRevision(plan, { readSource: async (url) => url.pathname === path ? "repaired" : "original" }), original);
  }
});

// Fails closed when the verifier installation is incomplete instead of silently resetting the retry limit.
test("browser runner revision propagates missing source errors", async () => {
  const error = Object.assign(new Error("Missing runner"), { code: "ENOENT" });
  await assert.rejects(ticketVerificationRunnerRevision(plan, { readSource: async () => { throw error; } }), error);
});

// Explicit requests for future tests must fingerprint lifecycle repairs without
// relying on the historical filesystem test filename.
test("agent-requested namespace fingerprints provisioning dependencies for any test", async () => {
  const paths = [];
  const options = { environment: "filesystem_namespace", readSource: async url => { paths.push(url.pathname); return "original"; } };
  const original = await ticketVerificationRunnerRevision([], options);
  const manager = paths.find(path => path.endsWith("filesystem-namespace-runner.js"));
  assert.ok(manager);
  assert.notEqual(await ticketVerificationRunnerRevision([], { ...options, readSource: async url => url.pathname === manager ? "repaired" : "original" }), original);
});
