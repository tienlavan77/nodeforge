import { Codex as DefaultCodex } from "@openai/codex-sdk";
import { fileURLToPath } from "node:url";
import { ConfigurationError } from "../../shared/errors.js";
import { createCodexForgeMcpSession } from "./codex-forge-mcp-session.js";

const SAFE_URL = /^https:\/\//;

export function createCodexSdkGateway({
  configuration,
  credentialResolver,
  CodexClass = DefaultCodex,
  timeoutMs = 120000,
  environment = process.env
} = {}) {
  if (typeof configuration?.getById !== "function") throw new ConfigurationError("Codex SDK Gateway requires Node Agent Configuration.");
  if (typeof credentialResolver !== "function") throw new ConfigurationError("Codex SDK Gateway requires a credential resolver.");
  if (typeof CodexClass !== "function") throw new ConfigurationError("Codex SDK Gateway requires a Codex constructor.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ConfigurationError("Codex SDK Gateway timeout must be a positive integer.");

  return Object.freeze({ execute });

  async function execute({ agentId, agent, prompt, correlationId, cwd, options = {}, onEvent, onSessionReady } = {}) {
    const profile = getEnabledConfig(agentId ?? agent?.agent_id);
    assertString(prompt, "Codex SDK prompt");
    assertString(correlationId, "Codex SDK correlation_id");
    const credential = await resolveCredential(profile.credential_ref);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let mcpSession;
    try {
      mcpSession = options.forgeTools ? await createCodexForgeMcpSession(options.forgeTools) : null;
      const bridgePath = fileURLToPath(new URL("../../../scripts/codex-forge-mcp-bridge.mjs", import.meta.url));
      // Codex 0.154 keeps MCP behind the current MCP feature gate.  The SDK
      // accepts this as a normal config override and serializes the nested
      // `mcp_servers` object into the CLI's TOML overrides.  Without the gate
      // the bridge can start successfully but its tools are never exposed to
      // the model (the session only contains the built-in discovery calls).
      const codexConfig = mcpSession ? {
        features: { mcp_2026_07_28: true },
        suppress_unstable_features_warning: true,
        mcp_optional_startup_grace_ms: 10000,
        // exec mode has no interactive approver: an on-request policy without
        // a reviewer downgrades to `never`, which rejects every MCP tool call
        // ("MCP tool call requires approval, but approval policy is never").
        // auto_review is the exec equivalent of `--approve-for-me`: approval
        // requests are resolved automatically against the workspace sandbox.
        approvals_reviewer: "auto_review",
        mcp_servers: {
          forge: {
            command: process.execPath,
            args: [bridgePath],
            env: {
              NODEFORGE_CODEX_MCP_URL: mcpSession.url,
              NODEFORGE_CODEX_MCP_TOKEN: mcpSession.token,
              NODEFORGE_CODEX_MCP_DEFINITIONS: JSON.stringify(mcpSession.tools),
              NODEFORGE_CODEX_MCP_DEBUG_LOG: options.mcpDebugLog ?? `${process.cwd()}/.forge/runtime/nf/logs/codex-mcp.log`
            },
            startup_timeout_sec: 10,
            tool_timeout_sec: 120,
            // Codex 0.154 defers all MCP tools behind `tool_search` when the
            // model family supports it (e.g. gpt-5.5), so the tool names never
            // appear in the initial request and the model gives up. Omitting
            // the deferred surface promotes this server's tools to Direct.
            enabled_tools: mcpSession.tools.map((tool) => tool.name),
            omit_tools_from: ["deferred"],
            enabled: true
          }
        }
      } : undefined;
      if (mcpSession) {
        onSessionReady?.(mcpSession.tools.map((tool) => tool.name) ?? []);
      }
      const codex = new CodexClass({
        apiKey: credential,
        baseUrl: normalizeBaseUrl(profile.gateway_url),
        env: buildCodexChildEnvironment(environment, options.env),
        ...(codexConfig ? { config: codexConfig } : {})
      });
      const thread = codex.startThread({
        model: options.model ?? profile.model ?? undefined,
        workingDirectory: cwd ?? options.workingDirectory ?? process.cwd(),
        sandboxMode: options.sandboxMode ?? "workspace-write",
        // Codex treats MCP calls as approval-gated actions. `never` makes the
        // server visible in tools/list but blocks every tools/call. The Forge
        // tool-lab is already governed by Node's execution context, so allow
        // Codex to dispatch those MCP calls while keeping ordinary SDK turns
        // on the existing non-interactive policy.
        approvalPolicy: options.approvalPolicy ?? (mcpSession ? "on-request" : "never"),
        ...(normalizeReasoningEffort(options.modelReasoningEffort ?? profile.reasoning?.effort) ? { modelReasoningEffort: normalizeReasoningEffort(options.modelReasoningEffort ?? profile.reasoning?.effort) } : {}),
        networkAccessEnabled: options.networkAccessEnabled ?? false,
        webSearchMode: options.webSearchMode ?? "disabled",
        skipGitRepoCheck: options.skipGitRepoCheck ?? false
      });
      const streamed = await thread.runStreamed(prompt, { signal: controller.signal, ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}) });
      const items = [];
      let finalResponse = "";
      let usage = null;
      let turnFailure = null;
      for await (const rawEvent of streamed.events) {
        const event = sanitizeItems(rawEvent, credential);
        if (typeof onEvent === "function") await onEvent(event);
        if (event.type === "item.completed") {
          items.push(event.item);
          if (event.item?.type === "agent_message") finalResponse = event.item.text ?? finalResponse;
        } else if (event.type === "turn.completed") {
          usage = event.usage ?? null;
        } else if (event.type === "turn.failed") {
          turnFailure = event.error?.message ?? "Codex turn failed.";
        }
      }
      if (turnFailure) throw new ConfigurationError(`Codex SDK turn failed for ${profile.agent_id}: ${turnFailure}`);
      return {
        agent_id: profile.agent_id,
        agent_name: profile.agent_name,
        role: profile.role,
        correlation_id: correlationId,
        status: "completed",
        text: finalResponse,
        items,
        usage,
        thread_id: thread.id
      };
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) throw new ConfigurationError(`Codex SDK request timed out for ${profile.agent_id}.`, { cause: error });
      if (error instanceof ConfigurationError) throw error;
      const message = typeof error?.message === "string" && error.message ? error.message.replaceAll(credential, "[REDACTED]") : "unknown SDK error";
      throw new ConfigurationError(`Codex SDK request failed for ${profile.agent_id}: ${message}`, { cause: error });
    } finally {
      clearTimeout(timeout);
      await mcpSession?.close?.();
    }
  }

  function getEnabledConfig(id) {
    assertString(id, "Codex SDK agent_id");
    const config = configuration.getById(id);
    if (!config) throw new ConfigurationError(`Unknown Codex SDK profile: ${id}.`);
    if (!config.enabled) throw new ConfigurationError(`Codex SDK agent is disabled: ${id}.`);
    if (config.status !== "ready") throw new ConfigurationError(`Codex SDK agent is not ready: ${id}.`);
    if (typeof config.gateway_url !== "string" || !SAFE_URL.test(config.gateway_url)) throw new ConfigurationError(`Codex SDK gateway URL is invalid for ${id}.`);
    return structuredClone(config);
  }

  async function resolveCredential(reference) {
    const value = await credentialResolver(reference);
    if (typeof value !== "string" || value.length === 0) throw new ConfigurationError("Codex SDK credential is unavailable.");
    return value;
  }
}

export function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !SAFE_URL.test(value)) throw new ConfigurationError("Codex SDK gateway URL must use HTTPS.");
  const normalized = value.trim().replace(/\/+$/, "").replace(/\/responses?$/, "");
  return /\/v\d+$/.test(normalized) ? normalized : `${normalized}/v1`;
}

function normalizeReasoningEffort(value) {
  if (!value || value === "none") return undefined;
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new ConfigurationError(`${label} is required.`);
}

function sanitizeItems(value, credential) {
  if (Array.isArray(value)) return value.map((item) => sanitizeItems(item, credential));
  if (typeof value === "string") return value.replaceAll(credential, "[REDACTED]");
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeItems(item, credential)]));
}

function buildCodexChildEnvironment(baseEnvironment, overrides) {
  const env = { ...(baseEnvironment && typeof baseEnvironment === "object" ? baseEnvironment : process.env) };
  // A Control API can itself be launched from a Codex terminal.  Passing the
  // parent's live session/thread and managed permission markers to the child
  // makes the CLI treat the SDK invocation as a nested session and can disable
  // MCP discovery before the first turn.  The SDK sets its own API key and
  // originator; these values must be fresh for the agent process.
  for (const name of [
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
    "CODEX_PERMISSION_PROFILE",
    "CODEX_CI",
    "CODEX_MANAGED_BY_NPM",
    "CODEX_MANAGED_PACKAGE_ROOT",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"
  ]) delete env[name];
  if (overrides && typeof overrides === "object") Object.assign(env, overrides);
  return env;
}
