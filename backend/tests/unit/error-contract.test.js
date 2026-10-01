// Validates backend error contract normalization with redaction and scope/recoverable semantics.
import assert from "node:assert/strict";
import test from "node:test";

import { formatErrorBody, normalizeErrorContract } from "../../src/shared/error-contract.js";

test("redacts secrets, URLs and stack traces from message", () => {
  const c = normalizeErrorContract({ error: { code: "unknown_error", message: "failed at https://example.com/secret api_key=abc123\n  at foo (bar:1:2)\nTraceback error" }, fallbackMessage: "fallback" });
  assert.equal(c.message, "fallback");
  const c2 = normalizeErrorContract({ error: { code: "timeout", message: "timeout https://evil.com/path token=xyz" }, fallbackMessage: "fallback" });
  assert.ok(!c2.message.includes("evil.com"));
  assert.ok(c2.message.includes("[redacted-url]") || c2.message === "fallback");
});

test("maps recoverable codes and statuses to retry semantics", () => {
  const r1 = normalizeErrorContract({ error: { code: "timeout", message: "timeout" } });
  assert.equal(r1.retryable, true);
  assert.equal(r1.scope, "scoped");
  const r2 = normalizeErrorContract({ error: { code: "validation_failed", message: "bad" } });
  assert.equal(r2.scope, "field");
  assert.equal(r2.retryable, false);
  const r3 = normalizeErrorContract({ error: { code: "unknown_error", message: "oops" }, statusCode: 429 });
  assert.equal(r3.retryable, true);
});

test("serializes ForgeError instances with exactly the canonical five fields", async () => {
  const { ForgeError } = await import("../../src/shared/errors.js");
  const serialized = JSON.parse(JSON.stringify(new ForgeError("failed", { code: "UPSTREAM_FAILED", retryable: true, scope: "scoped", requestId: "REQ-1" })));
  assert.deepEqual(Object.keys(serialized).sort(), ["code", "message", "requestId", "retryable", "scope"]);
  assert.deepEqual(serialized, { code: "UPSTREAM_FAILED", message: "failed", retryable: true, scope: "scoped", requestId: "REQ-1" });
});

test("preserves requestId and exposes stable contract via formatErrorBody", () => {
  const body = formatErrorBody({ error: { code: "dispatch_failed", message: "fail" }, statusCode: 502, requestId: "req-123", correlationId: "corr-1", fallbackMessage: "fallback" });
  assert.equal(body.error.code, "dispatch_failed");
  assert.equal(body.error.retryable, true);
  assert.equal(body.error.scope, "scoped");
  assert.equal(body.error.requestId, "req-123");
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "requestId", "retryable", "scope"]);
  assert.ok(!body.error.message.includes("stack"));
});
