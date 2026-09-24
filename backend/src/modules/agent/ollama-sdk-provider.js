// Resolves per-agent Ollama Cloud credentials and normalizes profiles.
// Profiles store only the bare host (e.g. https://ollama.com); the gateway
// appends /api/chat when executing, so this factory keeps the stored URL
// untouched and only validates HTTPS.
import { ConfigurationError } from "../../shared/errors.js";

const SAFE_URL = /^https:\/\//;

/**
 * Resolves per-agent Ollama credentials without starting a run.
 * Credentials are resolved only when createForAgent() is called and are
 * exposed to the gateway for the Authorization header, never copied
 * into logs or the normalized profile.
 */
// Creates a factory that normalizes profiles and resolves per-agent credentials.
export function createOllamaSdkProviderFactory({ credentialResolver } = {}) {
  if (typeof credentialResolver !== "function") throw new ConfigurationError("Ollama SDK provider requires a credential resolver.");

  return Object.freeze({ normalizeProfile, createForAgent, normalizeGatewayUrl, sdkChatUrl });

// Normalizes and validates a raw profile into the Ollama SDK credential and gateway shape.
  function normalizeProfile(profile) {
    if (!profile || typeof profile !== "object") throw new ConfigurationError("Ollama SDK agent profile is required.");
    return Object.freeze({
      agent_id: requireString(profile.agent_id, "Ollama SDK agent_id"),
      agent_name: requireString(profile.agent_name, "Ollama SDK agent_name"),
      role: requireString(profile.role, "Ollama SDK role"),
      gateway_url: normalizeGatewayUrl(profile.gateway_url),
      credential_ref: requireString(profile.credential_ref, "Ollama SDK credential_ref"),
      model: requireString(profile.model, "Ollama SDK model")
    });
  }

  async function createForAgent(profile) {
    const normalized = normalizeProfile(profile);
    const apiKey = await credentialResolver(normalized.credential_ref);
    if (typeof apiKey !== "string" || apiKey.length === 0) throw new ConfigurationError("Ollama SDK credential is unavailable.");
    return Object.freeze({ provider: Object.freeze({ apiKey }), profile: normalized });
  }
}

// Normalizes a gateway URL to bare-host form and validates HTTPS.
export function normalizeGatewayUrl(value) {
  if (typeof value !== "string" || !SAFE_URL.test(value)) throw new ConfigurationError("Ollama SDK gateway URL must use HTTPS.");
  return value
    .replace(/\/+$/, "")
    .replace(/\/api\/chat$/, "")
    .replace(/\/v1\/chat\/completions$/, "")
    .replace(/\/chat\/completions$/, "")
    .replace(/\/v1$/, "");
}

// Derives the native chat URL from a stored gateway URL.
export function sdkChatUrl(gatewayUrl) {
  return `${normalizeGatewayUrl(gatewayUrl)}/api/chat`;
}

// Requires a non-empty trimmed string for a named profile field.
function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new ConfigurationError(`${label} is required.`);
  return value.trim();
}
