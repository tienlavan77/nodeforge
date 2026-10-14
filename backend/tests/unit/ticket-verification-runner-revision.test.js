// Verifies browser runner repairs unlock bounded retries without requiring unrelated ticket code changes.
import assert from "node:assert/strict";
import test from "node:test";
import { ticketVerificationRunnerRevision } from "../../src/modules/supervisor/ticket-verification-runner-revision.js";

const plan = [{ kind: "browser" }];

// Keeps non-browser retry accounting compatible with durable legacy receipts.
test("non-browser verification does not fingerprint external browser tooling", async () => {
  assert.equal(await ticketVerificationRunnerRevision([], { readSource: async () => { throw new Error("Unexpected read"); } }), null);
});

// Distinguishes each external runner repair while stable tooling retains the same retry identity.
test("browser runner revision changes for every runner dependency", async () => {
  const paths = [];
  const original = await ticketVerificationRunnerRevision(plan, { readSource: async (url) => { paths.push(url.pathname); return "original"; } });
  assert.equal(paths.length, 14);
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
