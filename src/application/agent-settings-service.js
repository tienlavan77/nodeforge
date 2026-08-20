import { ConfigurationError } from "../shared/errors.js";

const AGENTS = Object.freeze([
  ["architecture-manager", "Architecture Manager"], ["sprint-leader", "Sprint Leader"], ["builder", "Builder"], ["reviewer", "Reviewer"]
]);
const PROVIDERS = Object.freeze(["codex", "claude", "openai", "anthropic", "custom"]);

export function createAgentSettingsService({ profiles, configuration, gateway, now = () => new Date().toISOString(), secretStore = new Map() } = {}) {
  if (typeof profiles?.create !== "function" || typeof profiles?.update !== "function" || typeof profiles?.getAll !== "function" || typeof profiles?.getById !== "function") throw new ConfigurationError("Agent Settings requires an Agent Profile Store.");
  if (typeof configuration?.sync !== "function") throw new ConfigurationError("Agent Settings requires Node Agent Configuration.");
  if (typeof gateway?.testConnection !== "function") throw new ConfigurationError("Agent Settings requires an Agent Gateway.");
  return Object.freeze({ list, save, testConnection });

  function list() { return AGENTS.map(([agentId, agentName]) => sanitize(profiles.getById(agentId) ?? defaults(agentId, agentName))); }

  function save(input) {
    const agentId = input?.agent_id;
    const current = profiles.getById(agentId);
    const timestamp = now();
    const profile = {
      agent_id: agentId, agent_name: input.agent_name ?? current?.agent_name ?? AGENTS.find(([id]) => id === agentId)?.[1],
      gateway_url: input.gateway_url, credential_ref: input.credential_ref ?? current?.credential_ref ?? `runtime:${agentId}:api-key`,
      enabled: input.enabled === true, status: input.enabled === true ? "configured" : "disabled",
      provider: input.provider ?? current?.provider ?? "codex",
      model: input.model ?? current?.model ?? "",
      created_at: current?.created_at ?? timestamp, updated_at: timestamp
    };
    validateAgent(agentId, profile);
    if (input.api_key !== undefined) {
      if (typeof input.api_key !== "string" || input.api_key.length === 0) throw new ConfigurationError("API Key must be non-empty when provided.");
      secretStore.set(profile.credential_ref, input.api_key);
    }
    const stored = current ? profiles.update(profile) : profiles.create(profile);
    configuration.sync();
    return sanitize(stored);
  }

  async function testConnection(agentId) {
    const result = await gateway.testConnection(agentId);
    return { agent_id: agentId, status: result.status, gateway_url: result.gateway_url };
  }

  function defaults(agentId, agentName) { return { agent_id: agentId, agent_name: agentName, gateway_url: "https://gateway.example.test/agent", credential_ref: `runtime:${agentId}:api-key`, enabled: false, status: "disabled", created_at: null, updated_at: null, provider: "codex", model: "" }; }
}

function sanitize(profile) {
  const safe = { ...profile };
  delete safe.api_key;
  if (safe.provider === undefined) safe.provider = "codex";
  if (safe.model === undefined) safe.model = "";
  return { ...safe, api_key_masked: "********" };
}

function validateAgent(agentId, profile) {
  if (!AGENTS.some(([id]) => id === agentId)) throw new ConfigurationError(`Unsupported Agent Profile: ${agentId}.`);
  if (typeof profile.gateway_url !== "string" || !profile.gateway_url.startsWith("https://")) throw new ConfigurationError("Gateway URL must use HTTPS.");
  if (profile.provider !== undefined && !PROVIDERS.includes(profile.provider)) throw new ConfigurationError("Provider is invalid.");
  if (profile.model !== undefined && typeof profile.model !== "string") throw new ConfigurationError("Model must be a string.");
}
