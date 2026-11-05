// Business purpose: Protects the focused verification entry point used by System Engineer from rejecting valid PHP syntax checks.
// Technical description: Exercises validateCheckCommand with the supported `php -l` command and confirms shell injection and project-boundary protections remain active.

import assert from "node:assert/strict";
import test from "node:test";
import { validateCheckCommand } from "../../src/tools/roles/owner-engineer-tools.js";

test("run_check accepts php -l and direct project-relative PHP test files", () => {
  assert.doesNotThrow(() => validateCheckCommand("php -l plugins/document.php", "test"));
  assert.doesNotThrow(() => validateCheckCommand("php -l backend/tests/fixtures/example.php", "test"));
  assert.doesNotThrow(() => validateCheckCommand("php tests/print-file-thumbnail-environment.php", "test"));
  assert.doesNotThrow(() => validateCheckCommand("npm exec -- php tests/print-file-thumbnail-environment.php", "test"));
});

test("PHP run_check validation keeps command and path safety restrictions", () => {
  assert.throws(() => validateCheckCommand("php -l plugins/document.php; rm -rf .", "test"), { code: "INPUT_INVALID" });
  assert.throws(() => validateCheckCommand("php -l /tmp/document.php", "test"), { code: "INPUT_INVALID" });
  assert.throws(() => validateCheckCommand("php -l ../document.php", "test"), { code: "INPUT_INVALID" });
});

test("run_check accepts one quoted PHP inline integration script", () => {
  assert.doesNotThrow(() => validateCheckCommand("php -r 'echo 1;'", "test"));
  assert.throws(() => validateCheckCommand("php -r echo 1", "test"), { code: "INPUT_INVALID" });
  assert.throws(() => validateCheckCommand("php -r 'echo 1;' && rm -rf .", "test"), { code: "INPUT_INVALID" });
});
