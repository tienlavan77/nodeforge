// Validates frontend error normalization: redaction, scope routing and recoverable retry semantics.
import assert from "node:assert/strict";
import test from "node:test";

import { getErrorScope, normalizeBackendError } from "../lib/error-normalizer.js";
import { isRetryableError } from "../lib/ui-error.js";
import { formatNotification } from "../lib/notification-formatter.js";

test("redacts URLs, secrets and stack traces (safeMessage/redactSecrets/plainText)", () => {
  const fell = normalizeBackendError({ body: { error: { code: "unknown_error", message: "oops https://example.com/path token=abc\n  at foo (bar:1:2)\nstack trace: x" } }, status: 500, fallbackError: "fallback" });
  assert.equal(fell.message, "fallback");
  const redacted = normalizeBackendError({ body: { error: { code: "timeout", message: "timeout at https://evil.com/path" } }, status: 504, fallbackError: "fallback" });
  assert.ok(redacted.message.includes("[redacted-url]") || redacted.message === "fallback");
  const secret = normalizeBackendError({ body: { error: { code: "network_error", message: "failed api_key=supersecret" } }, status: 502, fallbackError: "fallback" });
  assert.ok(!secret.message.includes("supersecret"));
  assert.ok(secret.message.includes("[redacted]"));
});

test("raw JSON event bodies fall back to safe message", () => {
  const j = normalizeBackendError({ body: { error: { code: "unknown", message: '{"evil":1}' } }, status: 500, fallbackError: "safe fallback" });
  assert.equal(j.message, "safe fallback");
});

test("recoverable codes expose retry semantics", () => {
  const r = normalizeBackendError({ body: { error: { code: "timeout", message: "timeout" } }, status: 408, fallbackError: "fallback" });
  assert.equal(r.retryable, true);
  assert.equal(r.retryable, true);
  assert.equal(isRetryableError(r), true);
  const nr = normalizeBackendError({ body: { error: { code: "validation_failed", message: "bad" } }, status: 400, fallbackError: "fallback" });
  assert.equal(nr.retryable, false);
  assert.equal(nr.retryable, false);
  assert.equal(isRetryableError(nr), false);
});

test("scope routing: field vs scoped vs global", () => {
  const field = normalizeBackendError({ body: { error: { code: "validation_failed", message: "bad" } }, status: 400, fallbackError: "fallback" });
  assert.equal(field.scope, "field");
  assert.equal(getErrorScope(field), "field");
  const scoped = normalizeBackendError({ body: { error: { code: "dispatch_failed", message: "fail" } }, status: 502, fallbackError: "fallback" });
  assert.equal(scoped.scope, "scoped");
  assert.equal(getErrorScope(scoped), "scoped");
  const global = normalizeBackendError({ body: { error: { code: "unknown_error", message: "oops" } }, status: 500, fallbackError: "fallback" });
  assert.equal(global.scope, "global");
  assert.equal(getErrorScope(global), "global");
});

test("formatNotification reuses plainText filtering and blocks JSON/stack raw events", () => {
  const j = formatNotification({ notification: { message: '{"evil":1}', code: "unknown" } }, "fallback");
  assert.equal(j.message, "fallback");
  // plainText blocks stack traces -> fallback
  const stack = formatNotification({ notification: { message: "oops\n  at foo (bar:1:2)", code: "unknown" } }, "fallback2");
  assert.equal(stack.message, "fallback2");
  // Integration: error-normalizer redacts URL before formatting
  const normalized = normalizeBackendError({ body: { error: { code: "dispatch_failed", message: "fail https://evil.com/path" } }, status: 502, fallbackError: "fallback" });
  const n = formatNotification({ notification: { message: normalized.message, code: normalized.code }, status: 502 }, "fallback");
  assert.ok(!n.message.includes("evil.com"));
  const direct = formatNotification({ notification: { message: "failed token=supersecret https://private.example/key", code: "dispatch_failed" } });
  assert.ok(!direct.message.includes("supersecret"));
  assert.ok(!direct.message.includes("private.example"));
});

test("keeps safe reconciliation identifiers and honors non-retryable migration conflicts", () => {
  const error = normalizeBackendError({ body: { error: { code: "sprint_registry_migration_required", message: "reconcile", retryable: false, scope: "scoped", identifiers: ["SPRINT-A", "unsafe id", 3] } }, status: 409, fallbackError: "fallback" });
  assert.deepEqual(error.identifiers, ["SPRINT-A"]);
  assert.equal(error.retryable, false);
  assert.equal(error.scope, "scoped");
});

test("requestId preserved through normalization", () => {
  const r = normalizeBackendError({ body: { error: { code: "timeout", message: "t", requestId: "req-1" } }, status: 504, fallbackError: "fallback", requestId: "header-req" });
  assert.equal(r.requestId, "header-req");
  const r2 = normalizeBackendError({ body: { error: { code: "timeout", message: "t", requestId: "req-1" } }, status: 504, fallbackError: "fallback" });
  assert.equal(r2.requestId, "req-1");
});
