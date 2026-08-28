import test from "node:test";
import assert from "node:assert/strict";

// Regression coverage for the indexed-context notification contract. These tests
// exercise the control API through its public HTTP surface so filesystem access
// cannot be used as an implicit fallback.
const baseUrl = process.env.NODE_CONTROL_TEST_URL ?? "http://127.0.0.1:3100";

async function requestContext(target) {
  const response = await fetch(`${baseUrl}/api/agent/context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target })
  });
  const body = await response.json();
  return { response, body };
}

function assertNotification(result, expectedCode) {
  assert.equal(result.body.notification?.code, expectedCode);
  assert.equal(typeof result.body.notification?.suggested_action, "string");
  assert.equal(result.body.notification?.stack, undefined);
  assert.equal(result.body.notification?.stack_trace, undefined);
  assert.doesNotMatch(JSON.stringify(result.body), /\\bat .*\\([^)]*\\)|node:internal/);
}

test("indexed context ready returns index source and Context Pack", async () => {
  const result = await requestContext("backend/scripts/start-control-api.mjs");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.source, "index");
  assert.ok(result.body.context_pack ?? result.body.contextPack);
});

test("missing indexed context returns a notification instead of failing the ticket", async () => {
  const result = await requestContext("backend/tests/does-not-exist.mjs");
  assertNotification(result, "CONTEXT_MISSING");
  assert.match(result.body.notification.suggested_action, /list|path|create/i);
});

test("stale indexed context returns a notification without a stack trace", async () => {
  const result = await requestContext("backend/scripts/start-control-api.mjs?stale=1");
  assertNotification(result, "CONTEXT_STALE");
});

test("unavailable index returns a notification without filesystem fallback", async () => {
  const result = await requestContext("backend/scripts/start-control-api.mjs?index=unavailable");
  assertNotification(result, "INDEX_UNAVAILABLE");
});

test("invalid target returns the notification contract", async () => {
  const result = await requestContext("");
  assertNotification(result, "INVALID_TARGET");
});

test("paths outside the project guard remain hard denied", async () => {
  const result = await requestContext("../outside-project.txt");
  assert.equal(result.response.status, 403);
  assert.equal(result.body.error?.code ?? result.body.code, "PATH_DENIED");
  assert.equal(result.body.notification, undefined);
  assert.doesNotMatch(JSON.stringify(result.body), /\\bat .*\\([^)]*\\)|node:internal/);
});
