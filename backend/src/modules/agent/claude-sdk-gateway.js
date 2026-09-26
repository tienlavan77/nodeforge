// claude sdk gateway — handles claude sdk gateway logic for the agent subsystem.
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { ConfigurationError } from "../../shared/errors.js";

const SAFE_URL = /^https:\/\//;
const SECRET_FIELD = /(?:api[_-]?key|credential|secret|password|token|authorization)/i;

// createClaudeSdkGateway — create claude sdk gateway logic.
export function createClaudeSdkGateway({
  configuration,
  credentialResolver,
  queryFn = sdkQuery,
  timeoutMs = 120000,
  environment = process.env,
  gatewayBaseUrl = environment.FORGE_GATEWAY_BASE_URL,
  mcpServers = {},
  allowedTools = []
} = {}) {
  if (typeof configuration?.getById !== "function") throw new ConfigurationError("Claude SDK Gateway requires Node Agent Configuration.");
  if (typeof credentialResolver !== "function") throw new ConfigurationError("Claude SDK Gateway requires a credential resolver.");
  if (typeof queryFn !== "function") throw new ConfigurationError("Claude SDK Gateway requires a query function.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ConfigurationError("Claude SDK Gateway timeout must be a positive integer.");

  return Object.freeze({ execute, provider: "claude", conversationMode: "history" });

  async function execute({ agentId, prompt, correlationId, cwd, additionalDirectories = [], options = {}, resumeSessionId, onSessionReady } = {}) {
    const config = getEnabledConfig(agentId);
    assertString(prompt, "Claude SDK prompt");
    assertString(correlationId, "Claude SDK correlation_id");
    const credential = await resolveCredential(config.credential_ref);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const cloneableOptions = { ...options };
    delete cloneableOptions.mcpServers;
    delete cloneableOptions.forgeTools;
    const queryOptions = {
      ...structuredClone(cloneableOptions),
      abortController: controller,
      cwd: cwd ?? options.cwd ?? process.cwd(),
      additionalDirectories: [...additionalDirectories],
      ...(config.model || options.model ? { model: options.model ?? config.model } : {}),
      env: createGatewayEnvironment({ config, credential, optionsEnv: options.env }),
      ...(Object.keys(options.mcpServers ?? mcpServers).length ? { mcpServers: options.mcpServers ?? mcpServers } : {}),
      ...((options.allowedTools ?? allowedTools).length ? { allowedTools: [...(options.allowedTools ?? allowedTools)] } : {}),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(resumeSessionId ? { resume: resumeSessionId } : {})
    };

    let session;
    const messages = [];
    let sessionId = resumeSessionId ?? null;
    let notified = false;
    const notify = (id) => {
      if (notified || !id || typeof onSessionReady !== "function") return;
      notified = true;
      // eslint-disable-next-line no-silent-catch -- Session-ready callback is best-effort; the session continues.
      try { onSessionReady(id); } catch { /* best-effort */ }
    };
    try {
      session = queryFn({ prompt, options: queryOptions });
      for await (const message of session) {
        const clean = sanitize(message, credential);
        messages.push(clean);
        const sid = clean?.session_id ?? null;
        if (sid && !sessionId) sessionId = sid;
        if (sid) notify(sid);
      }
      if (sessionId) notify(sessionId);
      return {
        agent_id: config.agent_id,
        agent_name: config.agent_name,
        role: config.role,
        correlation_id: correlationId,
        status: "completed",
        session_id: sessionId,
        messages,
        text: messages.flatMap((message) => message?.type === "assistant" ? (message.message?.content ?? []).map((block) => block?.text).filter((value) => typeof value === "string") : []).join("\n").trim()
      };
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) {
        throw new ConfigurationError(`Claude SDK request timed out for ${config.agent_id}.`, { cause: error });
      }
      const message = typeof error?.message === "string" && error.message
        ? error.message.replace(credential, "[REDACTED]")
        : "unknown SDK error";
      throw new ConfigurationError(`Claude SDK request failed for ${config.agent_id}: ${message}`, { cause: error });
    } finally {
      clearTimeout(timeout);
      if (typeof session?.close === "function") session.close();
    }
  }

  function createGatewayEnvironment({ config, credential, optionsEnv }) {
    const baseUrl = config.gateway_url || gatewayBaseUrl;
    if (typeof baseUrl !== "string" || !SAFE_URL.test(baseUrl)) {
      throw new ConfigurationError("Claude SDK third-party gateway URL is unavailable.");
    }
    return {
      ...environment,
      ...(optionsEnv && typeof optionsEnv === "object" ? optionsEnv : {}),
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: credential,
      ANTHROPIC_API_KEY: ""
    };
  }

  function getEnabledConfig(agentId) {
    assertString(agentId, "Claude SDK agent_id");
    const config = configuration.getById(agentId);
    if (!config) throw new ConfigurationError(`Unknown Claude SDK profile: ${agentId}.`);
    if (!config.enabled) throw new ConfigurationError(`Claude SDK agent is disabled: ${agentId}.`);
    if (config.status !== "ready") throw new ConfigurationError(`Claude SDK agent is not ready: ${agentId}.`);
    if (config.gateway_url !== undefined && (typeof config.gateway_url !== "string" || !SAFE_URL.test(config.gateway_url))) throw new ConfigurationError(`Claude SDK gateway URL is invalid for ${agentId}.`);
    return structuredClone(config);
  }


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
function sanitize(value, credential) {
  if (typeof value === "string") return value.split(credential).join("[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => sanitize(item, credential));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_FIELD.test(key))
    .map(([key, item]) => [key, sanitize(item, credential)]));
}
