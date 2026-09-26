import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
  assert.equal(gateway.provider, "claude");
  assert.equal(gateway.conversationMode, "history");
  assert.equal(result.agent_name, "Coder");
  assert.equal(result.text, "Hello from coder.");
  assert.equal(result.correlation_id, "CORR-HELLO");
  assert.equal(result.messages[0].message.content[0].text, "Hello from coder.");
  assert(!JSON.stringify(result).includes("gateway-secret"));
});

test("does not pass Forge registry functions into structured SDK options", async () => {
  let request;
  const gateway = createClaudeSdkGateway({
    configuration: { getById: () => profile() },
    credentialResolver: () => "secret",
    queryFn: ({ options }) => { request = options; return query([]); }
  });
  await gateway.execute({
    agentId: "coder",
    correlationId: "CORR-CLONE",
    prompt: "hello",
    options: { forgeTools: { registry: { read_file: { execute: () => {} } }, context: { task_id: "T" }, definitions: [] } }
  });
  assert.equal(request.forgeTools, undefined);
});

// Confirms owner conversations expose only Forge-approved MCP tools and execute through Node.
test("owner conversation gives Claude only its role-approved Forge tools", async () => {
  let request;
  const gateway = createClaudeSdkGateway({
    configuration: { getById: () => profile() }, credentialResolver: () => "secret",
    queryFn: ({ options }) => { request = options; return query([]); },
    allowedTools: ["Bash"]
  });
  const calls = [];
  await gateway.execute({ agentId: "coder", correlationId: "CORR-FORGE", prompt: "Inspect files", options: {
    forgeTools: {
      definitions: [{ name: "search_tree", description: "List project files", input_schema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } }],
      registry: { search_tree: { execute: async (input, context) => { calls.push({ input, context }); return { tree: ".\n└── docs/" }; } } },
      context: { task_id: "CORR-FORGE" }
    }
  } });
  assert.deepEqual(request.allowedTools, ["mcp__forge__search_tree"]);
  assert.deepEqual(request.tools, []);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "forge-test", version: "1.0.0" });
  try {
    await request.mcpServers.forge.instance.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools.map((item) => item.name), ["search_tree"]);
    const result = await client.callTool({ name: "search_tree", arguments: { path: "." } });
    assert.deepEqual(JSON.parse(result.content[0].text), { tree: ".\n└── docs/" });
    assert.deepEqual(calls, [{ input: { path: "." }, context: { task_id: "CORR-FORGE" } }]);
  } finally {
    await client.close();
    await request.mcpServers.forge.instance.close();
  }
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
