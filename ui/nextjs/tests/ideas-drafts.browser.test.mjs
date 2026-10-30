/**
 * Runs all approved notebook draft scenarios with Node's Chromium verification service.
 * The runner owns isolation and viewport execution; failures propagate as real test failures.
 * This focused entry point supplements, and does not replace, commit-bound ticket verification.
 */
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runBrowserVerification } from "../../../backend/src/modules/supervisor/browser/browser-verification-runner.js";
import { browserAssertions } from "./ideas-drafts.browser.mjs";

test("Ideas draft safety in Chromium at 375, 768 and 1440 pixels", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  await runBrowserVerification({
    projectRoot: root, sourceRoot: root,
    step: {
      kind: "browser", scenario_path: "ui/nextjs/tests/ideas-drafts.browser.mjs",
      viewports: [375, 768, 1440], assertions: Object.keys(browserAssertions),
      criterion_ids: Array.from({ length: 17 }, (_, index) => "AC-" + (index + 1))
    }
  });
});
