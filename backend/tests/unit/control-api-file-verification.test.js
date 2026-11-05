// Business purpose: Verifies automatic post-write checks can target tests and PHP files inside admitted catalog projects.
// Technical description: Covers project-relative test path discovery, focused command selection, and rejection of unsafe or unsupported paths before TestService dispatch.

import assert from "node:assert/strict";
import test from "node:test";
import { createOnWriteVerifier, isTestSourcePath, testCommandForPath } from "../../scripts/control-api-file-verification.mjs";

test("automatic verification recognizes tests from added project roots", () => {
  assert.equal(isTestSourcePath("tests/Feature/DocumentTest.php"), true);
  assert.equal(isTestSourcePath("document/tests/Feature/DocumentTest.php"), true);
  assert.equal(isTestSourcePath("document/specs/document.test.js"), true);
  assert.equal(isTestSourcePath("document/src/Document.php"), false);
});

test("automatic verification selects PHP and JavaScript focused commands", () => {
  assert.equal(testCommandForPath("document/tests/Feature/DocumentTest.php"), "php -l document/tests/Feature/DocumentTest.php");
  assert.equal(testCommandForPath("document/tests/document.test.js"), "node --test document/tests/document.test.js");
  assert.equal(testCommandForPath("document/tests/document.spec.ts"), "node --test document/tests/document.spec.ts");
  assert.equal(testCommandForPath("document/tests/README.md"), undefined);
});

test("automatic verification rejects unsafe paths and does not dispatch unsupported files", async () => {
  assert.equal(testCommandForPath("/tmp/document.php"), undefined);
  assert.equal(testCommandForPath("document/../outside.php"), undefined);
  const calls = [];
  const verifyWrite = createOnWriteVerifier({
    getTestService: () => ({ runTests: async (input) => { calls.push(input); return { status: "passed", ready_for_review: true }; } })
  });
  assert.equal(await verifyWrite({ path: "document/src/Document.php" }), undefined);
  const result = await verifyWrite({ path: "document/tests/Feature/DocumentTest.php" });
  assert.equal(result.status, "passed");
  assert.deepEqual(calls.map(({ command }) => command), ["php -l document/tests/Feature/DocumentTest.php"]);
});
