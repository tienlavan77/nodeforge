// Verifies application errors cross HTTP and SSE boundaries as one safe public envelope.
import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createHttpApi } from "../../src/transport/http/server.js";
import { projectConversationMessages } from "../../src/transport/sse/project-stream-conversation.js";
import { normalizeError } from "../../src/application/test-service.js";
import { normalizeAgentError } from "../../src/application/agent-settings-service.js";
import { normalizeBackendError } from "../../../ui/nextjs/lib/error-normalizer.js";
import { requestJson } from "../../../ui/nextjs/lib/node-client-request.js";
import { normalizeErrorContract } from "../../src/shared/error-contract.js";

// Starts a real HTTP listener and checks only canonical fields reach consumers.
test("application error remains canonical across HTTP, SSE, and UI ingress", async () => {
  const source = { code: "UPSTREAM_FAILED", message: "Upstream failed token=private123", retryable: false, requestId: "REQ-SOURCE" };
  const server = createHttpApi({ forgeV1Router: { route: async () => { throw Object.assign(new Error(source.message), { ...source, statusCode: 502 }); } } }).createServer();
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/forge/v1/legacy`, { headers: { "x-request-id": "REQ-HTTP" } });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "requestId", "retryable", "scope"]);
    assert.equal(body.error.code, "upstream_failed");
    assert.equal(body.error.retryable, false);
    assert.equal(body.error.requestId, "REQ-HTTP");
    assert.ok(!JSON.stringify(body).includes("private123"));
    assert.deepEqual(normalizeBackendError({ body, status: response.status }), body.error);
    await assert.rejects(requestJson(`http://127.0.0.1:${server.address().port}/forge/v1/legacy`), (error) => {
      assert.equal(error.code, "upstream_failed");
      assert.equal(error.retryable, false);
      assert.equal(error.scope, "global");
      assert.deepEqual(Object.keys(error.cause.error).sort(), ["code", "message", "requestId", "retryable", "scope"]);
      return true;
    });

    const event = projectConversationMessages({ id: "MSG-1", conversation_id: "CONV-1", correlation_id: "REQ-SSE", message_type: "agent.error", sender: { id: "AGENT-1", role: "agent" }, payload: { error: source } })[0];
    assert.equal(event.event_type, "conversation.message.failed");
    assert.deepEqual(Object.keys(event.payload.error).sort(), ["code", "message", "requestId", "retryable", "scope"]);
    assert.equal(event.payload.error.retryable, false);
    assert.equal(event.payload.error.requestId, "REQ-SSE");
    assert.ok(!JSON.stringify(event).includes("private123"));

    const application = normalizeError(source);
    assert.deepEqual(Object.keys(application).sort(), ["code", "message", "requestId", "retryable", "scope"]);
    assert.equal(application.requestId, "REQ-SOURCE");
    const agentError = normalizeAgentError(source);
    assert.deepEqual(Object.keys(agentError).sort(), ["code", "message", "requestId", "retryable", "scope"]);
    assert.equal(agentError.retryable, false);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("legacy error field aliases are not accepted by live HTTP and UI adapters", () => {
  const legacy = { error_code: "LEGACY_FAILURE", message: "failed", recoverable: true, request_id: "REQ-OLD" };
  assert.deepEqual(normalizeErrorContract({ error: legacy }), { code: "unknown_error", message: "failed", retryable: false, scope: "global", requestId: null });
  assert.deepEqual(normalizeBackendError({ body: { error: legacy } }), { code: "unknown_error", message: "failed", retryable: false, scope: "global", requestId: null });
});
