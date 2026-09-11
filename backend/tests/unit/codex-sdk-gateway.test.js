import assert from "node:assert/strict";
import test from "node:test";
import { createCodexSdkGateway, normalizeBaseUrl } from "../../src/modules/agent/codex-sdk-gateway.js";

test("normalizes Codex gateway URLs", () => {
  assert.equal(normalizeBaseUrl("https://gateway.example.test"), "https://gateway.example.test/v1");
  assert.equal(normalizeBaseUrl("https://gateway.example.test/v1/responses"), "https://gateway.example.test/v1");
  assert.throws(() => normalizeBaseUrl("http://gateway.example.test"), /HTTPS/);
});

test("runs a ticket through Codex SDK with repository controls", async () => {
  let codexOptions;
  let threadOptions;
  let prompt;
  const gateway = createCodexSdkGateway({
    configuration: { getById: () => ({ agent_id: "codex-1", agent_name: "Codex Builder", role: "coder", gateway_url: "https://gateway.test/v1/responses", credential_ref: "secret", enabled: true, status: "ready", model: "gpt-5.5" }) },
    credentialResolver: () => "gateway-key",
    CodexClass: class FakeCodex {
      constructor(options) { codexOptions = options; }
      startThread(options) {
        threadOptions = options;
        return { id: "thread-1", runStreamed: async (value) => { prompt = value; return { events: (async function* () { yield { type: "item.completed", item: { type: "file_change", changes: [] } }; yield { type: "item.completed", item: { type: "agent_message", text: "implemented" } }; yield { type: "turn.completed", usage: null }; })() }; } };
      }
    }
  });
  const result = await gateway.execute({ agentId: "codex-1", correlationId: "CORR-1", cwd: "/repo", prompt: "Implement ticket" });
  assert.equal(codexOptions.apiKey, "gateway-key");
  assert.equal(codexOptions.baseUrl, "https://gateway.test/v1");
  assert.equal(threadOptions.workingDirectory, "/repo");
  assert.equal(threadOptions.sandboxMode, "workspace-write");
  assert.equal(threadOptions.approvalPolicy, "never");
  assert.equal(prompt, "Implement ticket");
  assert.equal(result.text, "implemented");
  assert.equal(result.thread_id, "thread-1");
});

test("enables the Codex MCP feature when Forge tools are attached", async () => {
  let codexOptions;
  const gateway = createCodexSdkGateway({
    configuration: { getById: () => ({ agent_id: "codex-mcp", agent_name: "Codex MCP", role: "coder", gateway_url: "https://gateway.test/v1/responses", credential_ref: "secret", enabled: true, status: "ready", model: "gpt-5.5" }) },
    credentialResolver: () => "gateway-key",
    CodexClass: class FakeCodex {
      constructor(options) { codexOptions = options; }
      startThread() {
        return { id: "thread-mcp", runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed", usage: null }; })() }) };
      }
    }
  });
  await gateway.execute({
    agentId: "codex-mcp",
    correlationId: "CORR-MCP",
    cwd: "/repo",
    prompt: "Use Forge tools.",
    options: {
      forgeTools: {
        registry: { ping: { execute: async () => ({ ok: true }) } },
        context: { task_id: "MCP-1" },
        definitions: [{ name: "ping", description: "Ping", input_schema: { type: "object", properties: {}, additionalProperties: false } }]
      }
    }
  });
  assert.equal(codexOptions.config.mcp_servers.forge.enabled, true);
  assert.equal(codexOptions.config.features.mcp_2026_07_28, true);
  assert.equal(codexOptions.config.suppress_unstable_features_warning, true);
  assert.equal(codexOptions.config.mcp_optional_startup_grace_ms, 10000);
  assert.equal(codexOptions.config.mcp_servers.forge.enabled, true);
  assert.deepEqual(codexOptions.config.mcp_servers.forge.enabled_tools, ["ping"]);
  assert.equal(codexOptions.config.mcp_servers.forge.env.NODEFORGE_CODEX_MCP_DEFINITIONS.includes("ping"), true);
});

test("does not leak the parent Codex session into the MCP child", async () => {
  let codexOptions;
  const gateway = createCodexSdkGateway({
    configuration: { getById: () => ({ agent_id: "codex-env", agent_name: "Codex Env", role: "coder", gateway_url: "https://gateway.test/v1/responses", credential_ref: "secret", enabled: true, status: "ready" }) },
    credentialResolver: () => "gateway-key",
    environment: { CODEX_SESSION_ID: "parent", CODEX_THREAD_ID: "parent-thread", CODEX_PERMISSION_PROFILE: ":workspace-write", KEEP_ME: "yes" },
    CodexClass: class FakeCodex {
      constructor(options) { codexOptions = options; }
      startThread() { return { id: "thread-env", runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed", usage: null }; })() }) }; }
    }
  });
  await gateway.execute({ agentId: "codex-env", correlationId: "CORR-ENV", prompt: "hello" });
  assert.equal(codexOptions.env.CODEX_SESSION_ID, undefined);
  assert.equal(codexOptions.env.CODEX_THREAD_ID, undefined);
  assert.equal(codexOptions.env.CODEX_PERMISSION_PROFILE, undefined);
  assert.equal(codexOptions.env.KEEP_ME, "yes");
});
