// claude sdk gateway — handles claude sdk gateway logic for the agent subsystem.
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { readClaudeSessionContext } from "./claude-session-context.js";
import { join } from "node:path";
import process from "node:process";
import { ConfigurationError } from "../../shared/errors.js";
import { safeConversationId, safeSubagentId } from "./runtime-instance.js";
import { resolveRuntimePath } from "../../infrastructure/filesystem/forge-paths.js";
import { prependNodeBin } from "./node-bin-path.js";
import { codexShellEnvironment } from "./codex-shell-environment.js";
import { claudeCacheEnvironment, claudeCacheUsage } from "./anthropic-prompt-cache.js";
import { sdkFailureEvidence } from "./sdk-failure-evidence.js";
import { claudeSdkResult } from "./claude-sdk-result.js";
import { createSdkTerminalLog } from "./sdk-terminal-log.js";
import { assertClaudeSessionStopped } from "./claude-session-process.js";

const SAFE_URL = /^https:\/\//;
const USAGE_FIELDS = new Set(["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"]);
const SECRET_FIELD = /(?:api[_-]?key|credential|secret|password|token|authorization)/i;
const CLAUDE_PARENT_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "FORGE_CLAUDE_AGENT_ID"];

// createClaudeSdkGateway — create claude sdk gateway logic.
export function createClaudeSdkGateway({
  configuration,
  credentialResolver,
  queryFn = sdkQuery,
  timeoutMs = 3600000,
  environment = process.env,
  gatewayBaseUrl = environment.FORGE_GATEWAY_BASE_URL,
  claudeHomeRoot,
  mcpServers = {},
  allowedTools = [],
  terminalOutput = process.stdout
} = {}) {
  if (typeof configuration?.getById !== "function") throw new ConfigurationError("Claude SDK Gateway requires Node Agent Configuration.");
  if (typeof credentialResolver !== "function") throw new ConfigurationError("Claude SDK Gateway requires a credential resolver.");
  if (typeof queryFn !== "function") throw new ConfigurationError("Claude SDK Gateway requires a query function.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ConfigurationError("Claude SDK Gateway timeout must be a positive integer.");
  if (claudeHomeRoot !== undefined && (typeof claudeHomeRoot !== "string" || !claudeHomeRoot)) throw new ConfigurationError("Claude SDK Gateway home root must be a non-empty string.");

  const active = new Set();
  return Object.freeze({ execute, inspectContext, assertSessionStopped: ({ agentId, sessionId, endedAt }) => assertClaudeSessionStopped(agentId, active.has(agentId), "/proc", sessionId, endedAt), provider: "claude", conversationMode: "history" });

  // Business purpose: lets Forge repair persisted context usage before deciding whether to resume.
  // Technical description: resolves the same conversation home used by execute and measures only its exact session transcript.
  function inspectContext({ agentId, conversationId, sessionId, cwd } = {}) {
    const config = getEnabledConfig(agentId);
    const segment = conversationId ? safeConversationId(conversationId, "Claude SDK conversation") : null;
    const home = join(claudeHomeRoot ?? resolveRuntimePath(cwd ?? process.cwd(), ".forge/runtime/nf/claude-homes"), config.agent_id, ...(segment ? ["conversations", segment] : []));
    return readClaudeSessionContext(home, sessionId, terminalOutput);
  }

  // Defines execute function behavior for claude-sdk-gateway.js.
  async function execute({ agentId, subagentId, conversationId, prompt, correlationId, cwd, additionalDirectories = [], options = {}, resumeSessionId, onSessionReady, onEvent, abortSignal } = {}) {
    const config = getEnabledConfig(agentId);
    const instanceKey = subagentId ? `${agentId}:sub:${safeSubagentId(subagentId, "Claude SDK")}` : agentId;
    assertString(prompt, "Claude SDK prompt");
    assertString(correlationId, "Claude SDK correlation_id");
    const credential = await resolveCredential(config.credential_ref);
    const workingDirectory = cwd ?? options.cwd ?? process.cwd();
    const safeChildId = subagentId ? safeSubagentId(subagentId, "Claude SDK") : null;
    const conversationKey = conversationId ? safeConversationId(conversationId, "Claude SDK") : null;
    const claudeHome = join(claudeHomeRoot ?? resolveRuntimePath(workingDirectory, ".forge/runtime/nf/claude-homes"), config.agent_id, ...(conversationKey ? ["conversations", conversationKey] : []), ...(safeChildId ? ["subagents", safeChildId] : []));
    mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    const canResumeSession = Boolean(resumeSessionId) && (!conversationId || hasProviderState(claudeHome));
    const controller = new AbortController();
    // Defines stop function behavior for claude-sdk-gateway.js.
    const stop = () => controller.abort(abortSignal.reason);
    abortSignal?.addEventListener("abort", stop, { once: true });
    if (abortSignal?.aborted) stop();
    // System Engineer sessions run until completion or explicit Stop, regardless of gateway duration.
    const timeout = config.role === "system_engineer" ? null : setTimeout(() => controller.abort(), timeoutMs);
    const { canUseTool, onBuiltinToolEvent, onTextDelta, hooks, ...cloneableOptions } = options;
    delete cloneableOptions.mcpServers;
    delete cloneableOptions.forgeTools;
    const model = subagentId ? config.subagent_model ?? options.model ?? config.model : options.model ?? config.model;
    const effort = subagentId ? options.effort ?? "low" : options.effort ?? config.reasoning?.effort;
    if (effort !== undefined && !["none", "low", "medium", "high", "xhigh", "max"].includes(effort)) throw new ConfigurationError("Claude SDK reasoning effort is invalid.");
    const maxOutputTokens = options.maxOutputTokens ?? options.max_output_tokens ?? config.max_output_tokens;
    const queryOptions = {
      settingSources: [],
      ...structuredClone(cloneableOptions),
      ...(Number.isSafeInteger(maxOutputTokens) && maxOutputTokens >= 1 ? { maxOutputTokens } : {}),
      ...(effort === "none" ? { thinking: { type: "disabled" } } : effort ? { effort } : {}),
      ...(hooks ? { hooks } : {}),
      ...(typeof canUseTool === "function" ? { canUseTool } : {}),
      abortController: controller,
      cwd: workingDirectory,
      additionalDirectories: [...additionalDirectories],
      ...(model ? { model } : {}),
      env: createGatewayEnvironment({ config, credential, optionsEnv: options.env, projectRoot: workingDirectory, claudeHome }),
      ...(Object.keys(options.mcpServers ?? mcpServers).length ? { mcpServers: options.mcpServers ?? mcpServers } : {}),
      ...((options.allowedTools ?? allowedTools).length ? { allowedTools: [...(options.allowedTools ?? allowedTools)] } : {}),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(!subagentId && canResumeSession ? { resume: resumeSessionId } : {})
    };

    let session;
    const messages = [];
    let sessionId = resumeSessionId ?? null;
    let notified = false;
    const builtinSearchCalls = new Map();
    let terminalFailure;
    const terminal = createSdkTerminalLog({ profile: { ...config, provider: config.provider ?? "anthropic", model: options.model ?? config.model }, context: options.forgeTools?.context, correlationId, credential, output: terminalOutput });
    // Defines notify function behavior for claude-sdk-gateway.js.
    const notify = (id) => {
      if (notified || !id || typeof onSessionReady !== "function") return;
      notified = true;
      // eslint-disable-next-line no-silent-catch -- Session-ready callback is best-effort; the session continues.
      try { onSessionReady(id); } catch { /* best-effort */ }
    };
    try {
      active.add(instanceKey);
      session = queryFn({ prompt, options: queryOptions });
      for await (const message of session) {
        const clean = sanitize(message, credential);
        messages.push(clean);
        if (config.role === "system_engineer") await onEvent?.(clean);
        reportBuiltinToolEvents(clean, onBuiltinToolEvent, builtinSearchCalls);
        if (clean.type === "stream_event" && clean.event?.type === "content_block_delta" && clean.event.delta?.type === "text_delta") onTextDelta?.(clean.event.delta.text);
        const sid = clean?.session_id ?? null;
        if (sid && !sessionId) sessionId = sid;
        if (sid) notify(sid);
      }
      if (sessionId) notify(sessionId);
      const response = claudeSdkResult(messages, { structured: options.outputFormat?.type === "json_schema" });
      const usage = claudeCacheUsage(messages);
      const persistedContextTokens = readClaudeSessionContext(claudeHome, sessionId, terminalOutput);
      if (usage && persistedContextTokens > 0) usage.context_input_tokens = persistedContextTokens;
      return {
        usage,
        agent_id: config.agent_id,
        agent_name: config.agent_name,
        role: config.role,
        correlation_id: correlationId,
        status: "completed",
        turn_completed: messages.findLast((message) => message.type === "result")?.subtype === "success",
        session_id: sessionId,
        messages,
        ...response,
        // Keep normalized cache-aware usage authoritative over adapter response defaults.
        usage
      };
    } catch (error) {
      terminalFailure = error;
      if (abortSignal?.aborted) throw abortSignal.reason;
      if (error?.name === "AbortError" || controller.signal.aborted) {
        const failure = new ConfigurationError(`Claude SDK request timed out for ${config.agent_id}.`, { cause: error });
        failure.code = "SDK_REQUEST_TIMEOUT";
        throw sdkFailureEvidence(failure, error, { aborted: true });
      }
      const message = typeof error?.message === "string" && error.message
        ? error.message.replace(credential, "[REDACTED]")
        : "unknown SDK error";
      const failure = new ConfigurationError(`Claude SDK request failed for ${config.agent_id}: ${message}`, { cause: error });
      if (error.code === "SDK_MAX_OUTPUT_TOKENS" || /max_output_tokens|max[_ ]tokens/i.test(message)) Object.assign(failure, { code: "SDK_MAX_OUTPUT_TOKENS", incomplete_details: error.incomplete_details ?? { reason: "max_output_tokens" }, provider_outcome: "failed", retry_safe: false });
      else if (error.code?.startsWith("CLAUDE_SDK_")) Object.assign(failure, { code: error.code, provider_outcome: error.provider_outcome, retry_safe: false, sdk_subtype: error.sdk_subtype });
      throw sdkFailureEvidence(failure, error, { ended: error.provider_outcome === "failed" });
    } finally {
      terminal.close(abortSignal?.aborted ? { code: "TICKET_STOPPED", message: "SDK session stopped." } : controller.signal.aborted ? { code: "SDK_REQUEST_TIMEOUT", message: "SDK request timed out." } : terminalFailure);
      abortSignal?.removeEventListener("abort", stop);
      clearTimeout(timeout);
      if (typeof session?.close === "function") session.close();
      if (typeof session?.return === "function") await session.return();
      active.delete(instanceKey);
      if (subagentId) {
        try { rmSync(claudeHome, { recursive: true, force: true }); }
        // eslint-disable-next-line no-unused-vars -- Child cleanup is best-effort and cannot mask the original SDK result.
        catch (cleanupError) { terminalOutput?.write?.(`[nodeforge] child Claude home cleanup failed for ${config.agent_id}.\n`); }
      }
    }
  }

  // Business purpose: prevents stale provider sessions from blocking compacted conversation recovery.
  // Technical description: checks whether the conversation-scoped Claude home contains persisted provider state before resume.
  function hasProviderState(home) {
    if (!existsSync(home)) return false;
    try { return readdirSync(home, { withFileTypes: true }).some((entry) => entry.isFile() || entry.isDirectory()); }
    catch (error) { terminalOutput?.write?.(`[nodeforge] Claude session-state probe failed: ${error.message}\\n`); return false; }
  }

  // Reports Claude native search starts and bounded completion metadata without source output.
  function reportBuiltinToolEvents(message, callback, calls) {
    if (typeof callback !== "function" || !Array.isArray(message?.message?.content)) return;
    for (const block of message.message.content) {
      if (message.type === "assistant" && block?.type === "tool_use" && ["Glob", "Grep", "Read", "Write", "Edit", "Bash", "WebSearch", "Agent"].includes(block.name)) {
        calls.set(block.id, block.name);
        callback({ tool: block.name, status: "started", path: block.input?.file_path ?? block.input?.path, command: block.input?.command });
      } else if (message.type === "user" && block?.type === "tool_result") {
        const tool = calls.get(block.tool_use_id) ?? "search";
        calls.delete(block.tool_use_id);
        const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null);
        callback({ tool, status: block.is_error ? "failed" : "success", result_bytes: Buffer.byteLength(content) });
      }
    }
  }

  // Defines createGatewayEnvironment function behavior for claude-sdk-gateway.js.
  function createGatewayEnvironment({ config, credential, optionsEnv, projectRoot, claudeHome }) {
    const baseUrl = config.gateway_url || gatewayBaseUrl;
    if (typeof baseUrl !== "string" || !SAFE_URL.test(baseUrl)) {
      throw new ConfigurationError("Claude SDK third-party gateway URL is unavailable.");
    }
    const env = { ...(environment && typeof environment === "object" ? environment : process.env) };
    for (const name of CLAUDE_PARENT_ENV) delete env[name];
    if (optionsEnv && typeof optionsEnv === "object") Object.assign(env, optionsEnv);
    for (const name of CLAUDE_PARENT_ENV) delete env[name];
    const shellEnvironment = codexShellEnvironment(env, projectRoot);
    return {
      ...env,
      ...shellEnvironment,
      PATH: prependNodeBin(env.PATH),
      ...claudeCacheEnvironment(),
      CLAUDE_CONFIG_DIR: claudeHome,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: credential,
      FORGE_CLAUDE_AGENT_ID: config.agent_id,
      ANTHROPIC_API_KEY: ""
    };
  }

  // Defines getEnabledConfig function behavior for claude-sdk-gateway.js.
  function getEnabledConfig(agentId) {
    assertString(agentId, "Claude SDK agent_id");
    const config = configuration.getById(agentId);
    if (!config) throw new ConfigurationError(`Unknown Claude SDK profile: ${agentId}.`);
    if (!config.enabled) throw new ConfigurationError(`Claude SDK agent is disabled: ${agentId}.`);
    if (config.status !== "ready" && config.status !== "working") throw new ConfigurationError(`Claude SDK agent is not ready: ${agentId}.`);
    if (config.gateway_url !== undefined && (typeof config.gateway_url !== "string" || !SAFE_URL.test(config.gateway_url))) throw new ConfigurationError(`Claude SDK gateway URL is invalid for ${agentId}.`);
    return structuredClone(config);
  }


  // Defines resolveCredential function behavior for claude-sdk-gateway.js.
  async function resolveCredential(reference) {
    const value = await credentialResolver(reference);
    if (typeof value !== "string" || value.length === 0) throw new ConfigurationError("Claude SDK credential is unavailable.");
    return value;
  }
}

// assertString — assert string logic.
function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new ConfigurationError(`${label} is required.`);
}

// sanitize — sanitize logic.
// Business purpose: validates child instance identifiers before they become runtime keys or filesystem segments.
// Technical description: accepts opaque identifiers with a conservative alphanumeric, underscore, and hyphen alphabet.
function sanitize(value, credential) {
  if (typeof value === "string") return value.split(credential).join("[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => sanitize(item, credential));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => USAGE_FIELDS.has(key) || !SECRET_FIELD.test(key))
    .map(([key, item]) => [key, sanitize(item, credential)]));
}
