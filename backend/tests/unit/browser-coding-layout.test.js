// Verifies immutable layout acceptance in real Chromium against the exact committed ticket UI.
import assert from "node:assert/strict";
import test from "node:test";
import { CODING_BROWSER_ASSERTIONS } from "../../src/modules/supervisor/browser/browser-coding-contract.js";
import { materializeTicketArchive } from "../../src/modules/supervisor/ticket/ticket-archive-materialization.js";
import { runBrowserVerification } from "../../src/modules/supervisor/browser/browser-verification-runner.js";
import { matchesBrowserEvidence } from "../../src/modules/supervisor/browser/browser-verification-evidence.js";

const step = { kind: "browser", criterion_ids: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-8", "AC-9", "AC-10"], viewports: [375, 768, 1440], assertions: CODING_BROWSER_ASSERTIONS.slice(17, 22) };

test("Chromium: all five approved layout assertions execute across every viewport", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1", timeout: 90000 }, async (context) => {
  const archive = process.env.NODEFORGE_BROWSER_COMMIT ? await materializeTicketArchive({ projectRoot: process.cwd(), commitSha: process.env.NODEFORGE_BROWSER_COMMIT }) : null;
  if (archive) context.after(archive.cleanup);
  const receipt = await runBrowserVerification({ step, sourceRoot: archive?.path ?? process.cwd(), projectRoot: process.cwd() });
  assert.equal(matchesBrowserEvidence(step, receipt), true);
  assert.equal(receipt.results.length, 3);
  assert.ok(receipt.results.every((result) => result.assertions.length === 5));
});
