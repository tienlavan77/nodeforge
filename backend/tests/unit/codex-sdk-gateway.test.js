import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import test from "node:test";
import { createCodexSdkGateway, normalizeBaseUrl } from "../../src/modules/agent/codex-sdk-gateway.js";

// Keeps native permission profiles effective by omitting legacy sandbox CLI overrides.
test("native permission profile omits legacy sandbox and network flags", async () => {
  let threadOptions;
  const gateway = createCodexSdkGateway({
    configuration: { getById: () => ({ agent_id: "native-engineer", role: "system_engineer", gateway_url: "https://gateway.test/v1", credential_ref: "secret", enabled: true, status: "ready" }) },
    credentialResolver: () => "key",
    CodexClass: class {
      startThread(options) { threadOptions = options; return { id: "T", runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed" }; })() }) }; }
    }
  });
  await gateway.execute({ agentId: "native-engineer", prompt: "Inspect", correlationId: "C", options: { usePermissionProfile: true, config: { default_permissions: "engineer" } } });
  assert.equal(Object.hasOwn(threadOptions, "sandboxMode"), false);
  assert.equal(Object.hasOwn(threadOptions, "networkAccessEnabled"), false);
});

// Preserves the real startup failure when SDK exit stderr contains only a stdin notice.
test("preserves streamed failure instead of replacing it with generic process exit", async () => {
  const gateway = createCodexSdkGateway({
    configuration: { getById: () => ({ agent_id: "failure-probe", gateway_url: "https://gateway.test", credential_ref: "secret", enabled: true, status: "ready" }) },
    credentialResolver: () => "key",
    CodexClass: class {
      startThread() { return { id: "T", runStreamed: async () => ({ events: (async function* () { yield { type: "turn.failed", error: { message: "Sandbox initialization failed" } }; throw new Error("Codex Exec exited with code 1: Reading prompt from stdin..."); })() }) }; }
    }
  });
  await assert.rejects(gateway.execute({ agentId: "failure-probe", prompt: "Inspect", correlationId: "C" }), /Sandbox initialization failed/);
});

// Keeps multiline startup diagnostics visible through the public first-line error formatter.
test("includes actual startup error on the first line instead of the stdin banner", async () => {
  const gateway = createCodexSdkGateway({
    configuration: { getById: () => ({ agent_id: "startup-probe", gateway_url: "https://gateway.test", credential_ref: "secret", enabled: true, status: "ready" }) },
    credentialResolver: () => "key",
    CodexClass: class {
      startThread() { return { runStreamed: async () => { throw new Error("Codex Exec exited with code 1: Reading prompt from stdin...\nError: sandbox helper failed: Operation not permitted"); } }; }
    }
  });
  await assert.rejects(gateway.execute({ agentId: "startup-probe", prompt: "Inspect", correlationId: "C" }), (error) => {
    assert.match(error.message, /sandbox helper failed: Operation not permitted/);
    assert.doesNotMatch(error.message, /Reading prompt|\n/);
    return true;
  });
});

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
  assert.equal(codexOptions.config.model_provider, "nodeforge");
  assert.equal(codexOptions.config.model_providers.nodeforge.supports_websockets, false);
  assert.equal(codexOptions.config.model_providers.nodeforge.wire_api, "responses");
  assert.equal(codexOptions.config.model_providers.nodeforge.env_key, "CODEX_API_KEY");
  assert.equal(threadOptions.workingDirectory, "/repo");
  assert.equal(threadOptions.sandboxMode, "workspace-write");
  assert.equal(threadOptions.approvalPolicy, "never");
  assert.equal(prompt, "Implement ticket");
  assert.equal(result.text, "implemented");
  assert.equal(result.thread_id, "thread-1");
});

test("forwards role-specific Codex filesystem permissions without changing thread sandbox mode", async () => {
  let codexOptions;
  const gateway = createCodexSdkGateway({
    configuration: { getById: () => ({ agent_id: "engineer", role: "system_engineer", gateway_url: "https://gateway.test/v1", credential_ref: "secret", enabled: true, status: "ready" }) },
    credentialResolver: () => "gateway-key",
    CodexClass: class FakeCodex {
      constructor(options) { codexOptions = options; }
      startThread() { return { id: "engineer-thread", runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed" }; })() }) }; }
    }
  });
  await gateway.execute({ agentId: "engineer", correlationId: "CORR-ENGINEER", cwd: "/repo", prompt: "Inspect", options: { sandboxMode: "workspace-write", config: { default_permissions: "audit" }, configOverrides: ['permissions.audit.filesystem={":root"="deny","/repo"="write"}'] } });
  assert.equal(codexOptions.config.default_permissions, "audit");
  assert.equal(codexOptions.config.model_providers.nodeforge.supports_websockets, false);
  assert.deepEqual(codexOptions.configOverrides, ['permissions.audit.filesystem={":root"="deny","/repo"="write"}']);
});

// Stops an active Codex ticket turn with the owner cancellation reason.
test("owner Stop aborts the active Codex SDK turn", async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error("Ticket stopped by owner."), { code: "TICKET_STOPPED" });
  const gateway = createCodexSdkGateway({
    configuration: { getById: () => ({ agent_id: "codex-stop", role: "coder", gateway_url: "https://gateway.test/v1", credential_ref: "secret", enabled: true, status: "ready" }) },
    credentialResolver: () => "key",
    CodexClass: class FakeCodex {
      startThread() { return { id: "stop-thread", runStreamed: async (_prompt, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) }; }
    }
  });
  const running = gateway.execute({ agentId: "codex-stop", correlationId: "STOP", prompt: "Implement", abortSignal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(running, { code: "TICKET_STOPPED" });
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
    environment: { CODEX_SESSION_ID: "parent", CODEX_THREAD_ID: "parent-thread", CODEX_PERMISSION_PROFILE: ":workspace-write", OPENAI_API_KEY: "cli-key", CODEX_API_KEY: "stale-key", KEEP_ME: "yes" },
    CodexClass: class FakeCodex {
      constructor(options) { codexOptions = options; }
      startThread() { return { id: "thread-env", runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed", usage: null }; })() }) }; }
    }
  });
  await gateway.execute({ agentId: "codex-env", correlationId: "CORR-ENV", prompt: "hello" });
  assert.equal(codexOptions.env.CODEX_SESSION_ID, undefined);
  assert.equal(codexOptions.env.CODEX_THREAD_ID, undefined);
  assert.equal(codexOptions.env.CODEX_PERMISSION_PROFILE, undefined);
  assert.equal(codexOptions.env.OPENAI_API_KEY, undefined);
  assert.equal(codexOptions.env.CODEX_API_KEY, undefined);
  assert.equal(codexOptions.apiKey, "gateway-key");
  assert.equal(codexOptions.env.KEEP_ME, "yes");
});

test("normalizes the active Node bin directory after Codex environment overrides", async () => {
  let codexOptions;
  const gateway = createCodexSdkGateway({
    configuration: { getById: () => ({ agent_id: "codex-path", agent_name: "Codex Path", role: "coder", gateway_url: "https://gateway.test/v1", credential_ref: "secret", enabled: true, status: "ready" }) },
    credentialResolver: () => "gateway-key",
    environment: { PATH: "/usr/bin" },
    CodexClass: class FakeCodex {
      constructor(options) { codexOptions = options; }
      startThread() { return { id: "thread-path", runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed", usage: null }; })() }) }; }
    }
  });

  await gateway.execute({ agentId: "codex-path", correlationId: "CORR-PATH", prompt: "hello", options: { env: { PATH: ["/custom/bin", dirname(process.execPath)].join(delimiter) } } });

  const entries = codexOptions.env.PATH.split(delimiter);
  assert.equal(entries[0], dirname(process.execPath));
  assert.equal(entries.filter((entry) => entry === dirname(process.execPath)).length, 1);
  assert.equal(entries.includes("/custom/bin"), true);
});

// Classifies an upstream model-channel outage as retryable without exposing gateway diagnostics.
test("reports an unavailable model channel as a safe upstream outage", async () => {
  const gateway = createCodexSdkGateway({
    configuration: { getById: () => ({ agent_id: "codex-outage", agent_name: "Codex", role: "architecture_manager", gateway_url: "https://gateway.test/v1", credential_ref: "secret", enabled: true, status: "ready", model: "gpt-5.4" }) },
    credentialResolver: () => "gateway-key",
    CodexClass: class FakeCodex {
      startThread() { return { id: "thread-outage", runStreamed: async () => { throw new Error("Codex Exec exited with code 1: Reading prompt from stdin...\nunexpected status 503 Service Unavailable: No available channel for model gpt-5.4, url: https://gateway.test/v1/responses"); } }; }
    }
  });
  await assert.rejects(gateway.execute({ agentId: "codex-outage", correlationId: "OUTAGE", prompt: "Health check" }), (error) => {
    assert.equal(error.code, "SERVICE_UNAVAILABLE");
    assert.equal(error.statusCode, 503);
    assert.equal(error.message, "Gateway has no available channel for the selected model.");
    return true;
  });
});

test("uses each profile key and a separate Codex home instead of CLI credentials", async () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "nodeforge-codex-home-test-"));
  const captured = [];
  const profiles = Object.fromEntries(["agent-one", "agent-two"].map((agent_id) => [agent_id, {
    agent_id, agent_name: agent_id, role: "coder", gateway_url: "https://gateway.test/v1/responses",
    credential_ref: `runtime:${agent_id}:api-key`, enabled: true, status: "ready"
  }]));
  try {
    const gateway = createCodexSdkGateway({
      configuration: { getById: (agentId) => profiles[agentId] },
      credentialResolver: (reference) => ({ "runtime:agent-one:api-key": "profile-key-one", "runtime:agent-two:api-key": "profile-key-two" })[reference],
      environment: { CODEX_HOME: "/cli/home", OPENAI_API_KEY: "cli-key", CODEX_API_KEY: "cli-key" },
      codexHomeRoot: homeRoot,
      CodexClass: class FakeCodex {
        constructor(options) { captured.push(options); }
        startThread() { return { id: "thread", runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed" }; })() }) }; }
      }
    });
    await gateway.execute({ agentId: "agent-one", correlationId: "ONE", prompt: "one" });
    await gateway.execute({ agentId: "agent-two", correlationId: "TWO", prompt: "two" });
    assert.deepEqual(captured.map((options) => options.apiKey), ["profile-key-one", "profile-key-two"]);
    assert.deepEqual(captured.map((options) => options.env.CODEX_HOME), [join(homeRoot, "agent-one"), join(homeRoot, "agent-two")]);
    assert.equal(captured.every((options) => options.env.OPENAI_API_KEY === undefined && options.env.CODEX_API_KEY === undefined), true);
  } finally {
    rmSync(homeRoot, { recursive: true, force: true });
  }
});

// Completion tools may await long Node checks within the existing session deadline instead of timing out at 120 seconds.
test("Codex report tool timeout follows the configured session deadline", async () => {
  let config;
  const gateway = createCodexSdkGateway({ timeoutMs: 600_000,
    configuration: { getById: () => ({ agent_id: "wait", gateway_url: "https://gateway.test", credential_ref: "secret", enabled: true, status: "ready" }) },
    credentialResolver: () => "key", terminalOutput: { write() {} },
    CodexClass: class {
      constructor(options) { config = options.config; }
      startThread() { return { runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed" }; })() }) }; }
    }
  });
  await gateway.execute({ agentId: "wait", prompt: "Finish report", correlationId: "WAIT", options: { forgeTools: {
    registry: { report_done: { execute: async () => ({}) } },
    definitions: [{ name: "report_done", input_schema: { type: "object", properties: {} } }]
  } } });
  assert.equal(config.mcp_servers.forge.tool_timeout_sec, 600);
});
