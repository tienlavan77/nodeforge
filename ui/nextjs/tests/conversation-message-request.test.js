// Verifies transient proxy failures recover history reads without replaying commands or hiding permanent API errors.
import assert from "node:assert/strict";
import test from "node:test";
import { createNodeClient } from "../lib/node-client.js";

for (const failure of [502, 503, 504, "network", "body"]) {
  test(`history GET retries ${failure} once with identical project and pagination`, async (context) => {
    let calls = 0;
    const requests = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
      requests.push({ url, options });
      if (++calls === 1) {
        if (failure === "network") throw new TypeError("fetch failed: ECONNRESET");
        if (failure === "body") return { ok: true, status: 200, text: async () => { throw new TypeError("terminated"); } };
        return new Response("socket hang up", { status: failure });
      }
      return new Response(JSON.stringify({ items: [{ id: "MESSAGE-A" }], next_cursor: "25" }));
    });
    const result = await createNodeClient().getConversationMessages({ projectId: "PROJECT-A", conversationId: "CONV-A", cursor: "5", order: "desc" });
    assert.equal(result.items[0].id, "MESSAGE-A");
    assert.equal(calls, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests[0].options.cache, "no-store");
    assert.match(requests[0].url, /project=PROJECT-A/);
    assert.match(requests[0].url, /cursor=5/);
  });
}

for (const status of [400, 401, 403, 404, 500, 200]) {
  test(`history does not retry permanent HTTP ${status} or malformed successful JSON`, async (context) => {
    const fetch = context.mock.method(globalThis, "fetch", async () => new Response("invalid response", { status }));
    await assert.rejects(createNodeClient().getConversationMessages({ projectId: "PROJECT-A", conversationId: "CONV-A" }));
    assert.equal(fetch.mock.calls.length, 1);
  });
}

test("history retry remains bounded when the proxy stays unavailable", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () => new Response("socket hang up", { status: 502 }));
  await assert.rejects(createNodeClient().getConversationMessages({ projectId: "PROJECT-A", conversationId: "CONV-A" }), { status: 502 });
  assert.equal(fetch.mock.calls.length, 2);
});

test("history never retries aborted requests", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () => { throw new DOMException("Cancelled", "AbortError"); });
  await assert.rejects(createNodeClient().getConversationMessages({ conversationId: "CONV-A" }));
  assert.equal(fetch.mock.calls.length, 1);
});

test("owner message POST is not retried on proxy reset", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () => new Response("socket hang up", { status: 502 }));
  await assert.rejects(createNodeClient().postOwnerMessage({ projectId: "PROJECT-A", conversationId: "CONV-A", agentId: "architecture-manager", text: "/plan workflows/input.md", messageId: "MSG-A", correlationId: "CORR-A" }));
  assert.equal(fetch.mock.calls.length, 1);
});
