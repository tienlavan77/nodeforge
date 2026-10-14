// Verifies registered presence assertions execute the committed Coding page in Chromium and emit complete evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { CODING_BROWSER_ASSERTIONS, assertCodingBrowserStep } from "../../src/modules/supervisor/browser-coding-contract.js";
import { buildTicketVerificationPlan } from "../../src/modules/supervisor/ticket-verification-plan.js";
import { runBrowserVerification } from "../../src/modules/supervisor/browser-verification-runner.js";
import { matchesBrowserEvidence } from "../../src/modules/supervisor/browser-verification-evidence.js";

const step = { kind: "browser", criterion_ids: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-6", "AC-7", "AC-8"], viewports: [375, 768, 1440], assertions: CODING_BROWSER_ASSERTIONS.slice(13, 17) };

test("all four approved presence checks schedule without admitting unsupported prose", async () => {
  assert.equal(step.assertions.length, 4);
  assert.doesNotThrow(() => assertCodingBrowserStep(step));
  const commands = await buildTicketVerificationPlan([], process.cwd(), { verificationPlan: [step] });
  assert.deepEqual(commands[0].browser_step, step);
  assert.throws(() => assertCodingBrowserStep({ ...step, assertions: ["Pretend presence is persisted"] }), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
});

test("Chromium: real Coding page satisfies storage, reload, run policy and storage failure assertions", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1", timeout: 90000 }, async () => {
  const receipt = await runBrowserVerification({ step, sourceRoot: process.env.NODEFORGE_BROWSER_SOURCE_ROOT ?? process.cwd(), projectRoot: process.cwd() });
  assert.equal(matchesBrowserEvidence(step, receipt), true);
  assert.equal(receipt.results.length, 3);
  assert.ok(receipt.results.every((result) => result.assertions.length === 4 && result.passed));
});
