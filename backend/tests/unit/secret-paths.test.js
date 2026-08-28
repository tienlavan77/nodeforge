import assert from "node:assert/strict";
import test from "node:test";

import { createSecretPathMatcher, redactSensitiveText } from "../../src/modules/context/secret-paths.js";

test("matches default secret path patterns and configured exclusions", () => {
  const isSecret = createSecretPathMatcher(["config/private/*"]);
  for (const path of [".env", ".env.local", "certs/server.pem", "keys/app.key", "tls/root.crt", "config/private/settings.json"]) {
    assert.equal(isSecret(path), true, path);
  }
  assert.equal(isSecret("src/config.js"), false);
});

test("redacts credentials in diagnostic text", () => {
  const output = redactSensitiveText("authorization: Bearer sk-example-secret api_key=hidden-value");
  assert.equal(output.includes("sk-example-secret"), false);
  assert.equal(output.includes("hidden-value"), false);
  assert.match(output, /REDACTED/);
});
