// Executes single-turn Ollama Cloud runs through the Claude Agent SDK.
// Profiles store only the bare host (e.g. https://ollama.com); the SDK reads
// it via ANTHROPIC_BASE_URL with the profile credential as ANTHROPIC_AUTH_TOKEN,
// the same pattern documented for third-party gateways.
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { ConfigurationError } from "../../shared/errors.js";

const SECRET_FIELD = /(?:api[_-]?key|credential|secret|password|token|authorization)/i;

// Creates a gateway that runs a single-turn prompt via the Claude Agent SDK against Ollama Cloud.
export function createOllamaSdkGateway({
  providerFactory,
  queryFn = sdkQuery,
  timeoutMs = 120000,
  environment = process.env
} = {}) {
  if (typeof providerFactory?.createForAgent !== "function") throw new ConfigurationError("Ollama SDK Gateway requires a provider factory.");
  if (typeof queryFn !== "function") throw new ConfigurationError("Ollama SDK Gateway requires a query function.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ConfigurationError("Ollama SDK Gateway timeout must be a positive integer.");

  return Object.freeze({ execute });

  async function execute({ agent, agentId, prompt, correlationId, cwd, options = {} } = {}) {
    const input = agent ?? { agent_id: agentId };
    if (typeof prompt !== "string" || !prompt.trim()) throw new ConfigurationError("Ollama SDK prompt is required.");
    if (typeof correlationId !== "string" || !correlationId) throw new ConfigurationError("Ollama SDK correlation_id is required.");
    const { provider, profile: normalized } = await providerFactory.createForAgent(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const queryOptions = {
      ...structuredClone(options),
      abortController: controller,
      cwd: cwd ?? options.cwd ?? process.cwd(),
      ...(normalized.model || options.model ? { model: options.model ?? normalized.model } : {}),
      env: {
        ...environment,
        ...(options.env && typeof options.env === "object" ? options.env : {}),
        ANTHROPIC_BASE_URL: normalized.gateway_url,
        ANTHROPIC_AUTH_TOKEN: provider.apiKey,
        ANTHROPIC_API_KEY: ""
      }
    };
    let session;
    const messages = [];
    try {
      session = queryFn({ prompt, options: queryOptions });
      for await (const message of session) messages.push(sanitize(message, provider.apiKey));
      return {
        agent_id: normalized.agent_id,
        agent_name: normalized.agent_name,
        role: normalized.role,
        correlation_id: correlationId,
        status: "completed",
        text: extractText(messages)
      };
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) throw new ConfigurationError(`Ollama SDK request timed out for ${normalized.agent_id}.`, { cause: error });
      if (error instanceof ConfigurationError) throw error;
      const message = typeof error?.message === "string" && error.message
        ? error.message.split(provider.apiKey).join("[REDACTED]")
        : "unknown SDK error";
      throw new ConfigurationError(`Ollama SDK request failed for ${normalized.agent_id}: ${message}`, { cause: error });
    } finally {
      clearTimeout(timer);
      if (typeof session?.close === "function") session.close();
    }
  }
}

// Extracts assistant text from Claude SDK messages, joining content blocks.
function extractText(messages) {
  const parts = [];
  for (const message of messages) {
    const blocks = message?.message?.content ?? message?.content ?? [];
    const items = Array.isArray(blocks) ? blocks : [blocks];
    for (const block of items) {
      if (typeof block?.text === "string") parts.push(block.text);
      else if (typeof block === "string") parts.push(block);
    }
  }
  return parts.filter(Boolean).join(" ").trim();
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
