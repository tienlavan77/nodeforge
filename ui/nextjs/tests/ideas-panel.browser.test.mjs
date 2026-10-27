/**
 * Runs the ticket's complete approved Chromium step through the existing Node browser verifier.
 * This focused entry point avoids a long encoded command argument while retaining the actual
 * fixture, assertion keys and three required viewport widths. Node owns browser launch,
 * isolation, assertion execution and the returned receipt; this module adds no substitute evidence.
 */
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runBrowserVerification } from "../../../backend/src/modules/supervisor/browser-verification-runner.js";
import { browserAssertions } from "./ideas-panel.browser.mjs";

test("Ideas panel approved Chromium scenarios at 375, 768 and 1440 pixels", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const receipt = await runBrowserVerification({
    projectRoot: root, sourceRoot: root,
    step: {
      kind: "browser", scenario_path: "ui/nextjs/tests/ideas-panel.browser.mjs",
      viewports: [375, 768, 1440], assertions: Object.keys(browserAssertions),
      criterion_ids: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-6", "AC-7", "AC-8", "AC-9", "AC-10", "AC-11", "AC-12", "AC-13"]
    }
  });
  console.log(JSON.stringify(receipt));
});
