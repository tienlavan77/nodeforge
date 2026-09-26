// Creates per-agent OpenAI provider instances from normalized profiles and resolved credentials.
import { OpenAIProvider as DefaultOpenAIProvider } from "@openai/agents";
import { ConfigurationError } from "../../shared/errors.js";

const SAFE_URL = /^https:\/\//;
const REASONING_EFFORTS = Object.freeze(["none", "low", "medium", "high", "max"]);

/**
 * Creates per-agent OpenAI Agents SDK providers without starting an Agent run.
 * Credentials are resolved only when createForAgent() is called and are never
 * copied into the normalized profile returned by this module.
 */
// Creates a factory that normalizes profiles and instantiates per-agent OpenAI providers.
export function createOpenAiSdkProviderFactory({ credentialResolver, ProviderClass = DefaultOpenAIProvider, defaultUseResponses = true } = {}) {
  if (typeof credentialResolver !== "function") throw new ConfigurationError("OpenAI SDK provider requires a credential resolver.");
  if (typeof ProviderClass !== "function") throw new ConfigurationError("OpenAI SDK provider requires a provider constructor.");
  if (typeof defaultUseResponses !== "boolean") throw new ConfigurationError("OpenAI SDK provider useResponses must be boolean.");

  return Object.freeze({ normalizeProfile, createForAgent, normalizeGatewayUrl, normalizeReasoningEffort });

// Normalizes and validates a raw profile into the OpenAI SDK credential and gateway shape.
  function normalizeProfile(profile) {
    if (!profile || typeof profile !== "object") throw new ConfigurationError("OpenAI SDK agent profile is required.");
    const gatewayUrl = normalizeGatewayUrl(profile.gateway_url);
    const model = requireString(profile.model, "OpenAI SDK model");
    const credentialRef = requireString(profile.credential_ref, "OpenAI SDK credential_ref");
    const effort = normalizeReasoningEffort(profile.reasoning?.effort ?? profile.reasoning_effort ?? "medium");
    return Object.freeze({
      agent_id: requireString(profile.agent_id, "OpenAI SDK agent_id"),
      agent_name: requireString(profile.agent_name, "OpenAI SDK agent_name"),
      role: requireString(profile.role, "OpenAI SDK role"),
      gateway_url: gatewayUrl,
      credential_ref: credentialRef,
      model,
      reasoning: Object.freeze({ effort }),
      use_responses: profile.use_responses ?? defaultUseResponses
    });
  }

  async function createForAgent(profile) {
    const normalized = normalizeProfile(profile);
    const apiKey = await credentialResolver(normalized.credential_ref);
    if (typeof apiKey !== "string" || apiKey.length === 0) throw new ConfigurationError("OpenAI SDK credential is unavailable.");
    const provider = new ProviderClass({
      apiKey,
      baseURL: normalized.gateway_url,
      useResponses: normalized.use_responses,
      strictFeatureValidation: false
    });
    return Object.freeze({ provider, profile: normalized });
  }
}

// Normalizes a gateway URL to the /v1 base form and validates HTTPS.
export function normalizeGatewayUrl(value) {
  if (typeof value !== "string" || !SAFE_URL.test(value)) throw new ConfigurationError("OpenAI SDK gateway URL must use HTTPS.");
  const normalized = value.replace(/\/+$/, "").replace(/\/responses?$/, "");
  return /\/v\d+$/.test(normalized) ? normalized : `${normalized}/v1`;
}

// Validates that the reasoning effort is one of the supported levels.
export function normalizeReasoningEffort(value) {
  if (!REASONING_EFFORTS.includes(value)) throw new ConfigurationError(`OpenAI SDK reasoning effort is invalid: ${value}.`);
  return value;
}

export const OPENAI_SDK_REASONING_EFFORTS = REASONING_EFFORTS;

// Requires a non-empty trimmed string for a named profile field.
function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new ConfigurationError(`${label} is required.`);
  return value.trim();
}
