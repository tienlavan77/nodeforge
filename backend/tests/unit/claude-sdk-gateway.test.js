import assert from "node:assert/strict";
import test from "node:test";

import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";

test("executes the selected agent through a third-party gateway", async () => {
  let request;
  const gateway = createClaudeSdkGateway({
    configuration: { getById: () => profile() },
    credentialResolver: async (reference) => {
      assert.equal(reference, "runtime:coder:gateway-token");
      return "gateway-secret";
    },
    queryFn: ({ prompt, options }) => {
      request = { prompt, options };
      return query([{ type: "assistant", message: { content: [{ type: "text", text: "Hello from coder." }] } }]);
    },
    environment: { PATH: "/usr/bin", FORGE_GATEWAY_BASE_URL: "https://fallback.example.test" },
    mcpServers: { forge: { type: "sdk" } },
    allowedTools: ["mcp__forge__say_hello"]
  });

  const result = await gateway.execute({
    agentId: "coder",
    correlationId: "CORR-HELLO",
    prompt: "Say hello.",
    cwd: "/workspace/project"
  });

  assert.equal(request.prompt, "Say hello.");
  assert.equal(request.options.cwd, "/workspace/project");
  assert.equal(request.options.env.ANTHROPIC_BASE_URL, "https://gateway.example.test/anthropic");
  assert.equal(request.options.env.ANTHROPIC_AUTH_TOKEN, "gateway-secret");
  assert.equal(request.options.env.ANTHROPIC_API_KEY, "");
  assert.deepEqual(request.options.mcpServers, { forge: { type: "sdk" } });
  assert.deepEqual(request.options.allowedTools, ["mcp__forge__say_hello"]);
  assert.equal(result.agent_id, "coder");
  assert.equal(result.agent_name, "Coder");
  assert.equal(result.correlation_id, "CORR-HELLO");
  assert.equal(result.messages[0].message.content[0].text, "Hello from coder.");
  assert(!JSON.stringify(result).includes("gateway-secret"));
});

test("does not execute a disabled or non-ready agent", async () => {
  let calls = 0;
  const gateway = createClaudeSdkGateway({
    configuration: { getById: (id) => ({ ...profile(), agent_id: id, enabled: id !== "disabled", status: id === "waiting" ? "working" : "ready" }) },
    credentialResolver: () => "secret",
    queryFn: () => { calls += 1; return query([]); }
  });

  await assert.rejects(() => gateway.execute({ agentId: "disabled", correlationId: "CORR-1", prompt: "hello" }), /disabled/);
  await assert.rejects(() => gateway.execute({ agentId: "waiting", correlationId: "CORR-2", prompt: "hello" }), /not ready/);
  assert.equal(calls, 0);
});

test("closes the SDK session and sanitizes SDK failures", async () => {
  let closed = false;
  const gateway = createClaudeSdkGateway({
    configuration: { getById: () => profile() },
    credentialResolver: () => "gateway-secret",
    queryFn: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => { throw new Error("gateway-secret upstream details"); }
        };
      },
      close() { closed = true; }
    })
  });

  await assert.rejects(() => gateway.execute({ agentId: "coder", correlationId: "CORR-3", prompt: "hello" }), (error) => {
    assert.match(error.message, /^Claude SDK request failed for coder: \[REDACTED\]/);
    assert(!error.message.includes("gateway-secret"));
    return true;
  });
  assert.equal(closed, true);
});

function profile() {
  return {
    agent_id: "coder",
    agent_name: "Coder",
    role: "coder",
    gateway_url: "https://gateway.example.test/anthropic",
    credential_ref: "runtime:coder:gateway-token",
    enabled: true,
    status: "ready",
    model: "claude-sonnet-5"
  };
}

function* query(messages) {
  for (const message of messages) yield message;
}
