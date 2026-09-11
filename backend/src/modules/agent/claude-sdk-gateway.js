import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { ConfigurationError } from "../../shared/errors.js";

const SAFE_URL = /^https:\/\//;
const SECRET_FIELD = /(?:api[_-]?key|credential|secret|password|token|authorization)/i;

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

  return Object.freeze({ execute });

  async function execute({ agentId, prompt, correlationId, cwd, additionalDirectories = [], options = {} } = {}) {
    const config = getEnabledConfig(agentId);
    assertString(prompt, "Claude SDK prompt");
    assertString(correlationId, "Claude SDK correlation_id");
    const credential = await resolveCredential(config.credential_ref);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const cloneableOptions = { ...options };
    delete cloneableOptions.mcpServers;
    const queryOptions = {
      ...structuredClone(cloneableOptions),
      abortController: controller,
      cwd: cwd ?? options.cwd ?? process.cwd(),
      additionalDirectories: [...additionalDirectories],
      ...(config.model || options.model ? { model: options.model ?? config.model } : {}),
      env: createGatewayEnvironment({ config, credential, optionsEnv: options.env }),
      ...(Object.keys(options.mcpServers ?? mcpServers).length ? { mcpServers: options.mcpServers ?? mcpServers } : {}),
      ...((options.allowedTools ?? allowedTools).length ? { allowedTools: [...(options.allowedTools ?? allowedTools)] } : {}),
      tools: options.tools ?? [],
    };

    let session;
    const messages = [];
    try {
      session = queryFn({ prompt, options: queryOptions });
      for await (const message of session) messages.push(sanitize(message, credential));
      return {
        agent_id: config.agent_id,
        agent_name: config.agent_name,
        role: config.role,
        correlation_id: correlationId,
        status: "completed",
        messages
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

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new ConfigurationError(`${label} is required.`);
}

function sanitize(value, credential) {
  if (typeof value === "string") return value.split(credential).join("[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => sanitize(item, credential));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_FIELD.test(key))
    .map(([key, item]) => [key, sanitize(item, credential)]));
}
