import assert from "node:assert/strict";
import test from "node:test";
import { isProtectedPath } from "../../src/infrastructure/filesystem/protected-path-policy.js";

test("protected policy blocks secrets and generated/runtime-hidden paths", () => {
  for (const path of [".env", "config/app.pem", ".git/config", ".next/cache/file", ".forge/config.json"]) assert.equal(isProtectedPath(path), true, path);
  assert.equal(isProtectedPath(".forge/runtime/index.db"), false);
  assert.equal(isProtectedPath("ui/nextjs/app/page.jsx"), false);
});

test("protected policy blocks hidden writes but permits normal source writes", () => {
  assert.equal(isProtectedPath(".DS_Store", { operation: "write" }), true);
  assert.equal(isProtectedPath("src/module.js", { operation: "write" }), false);
});
