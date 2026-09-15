import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

const PROVIDERS = Object.freeze(["codex", "claude", "openai", "anthropic", "custom"]);
const STATUSES = Object.freeze(["ready", "working", "not_connected"]);
const TEAMS = Object.freeze(["Backend", "Frontend", "Security"]);
// Keep persisted agent.team values aligned with the Agents UI Team selector options.

export function createAgentSettingsService({ profiles, configuration, gateway, now = () => new Date().toISOString(), secretStore = new Map() } = {}) {
  if (typeof profiles?.create !== "function" || typeof profiles?.update !== "function" || typeof profiles?.delete !== "function" || typeof profiles?.getAll !== "function" || typeof profiles?.getById !== "function") throw new ConfigurationError("Agent Settings requires an Agent Profile Store.");
  if (typeof configuration?.sync !== "function") throw new ConfigurationError("Agent Settings requires Node Agent Configuration.");
  if (typeof gateway?.testConnection !== "function") throw new ConfigurationError("Agent Settings requires an Agent Gateway.");
  return Object.freeze({ list, get, create, save, remove, testConnection });

  function list() { return profiles.getAll().map(sanitize); }

  function get(agentId) {
    const profile = profiles.getById(agentId);
    if (!profile) throw new ConfigurationError(`Unknown Agent Profile: ${agentId}.`);
    return sanitize(profile);
  }

  function create(input) {
    const profile = buildProfile(input, null);
    const stored = profiles.create(profile);
    configuration.sync();
    return sanitize(stored);
  }

  function save(input) {
    const current = profiles.getById(input?.agent_id);
    const profile = buildProfile(input, current ?? null);
    const stored = current ? profiles.update(profile) : profiles.create(profile);
    configuration.sync();
    return sanitize(stored);
  }

  function remove(agentId) {
    const current = profiles.getById(agentId);
    if (!current) throw new ConfigurationError(`Unknown Agent Profile: ${agentId}.`);
    const removed = profiles.delete(current.agent_id);
    configuration.sync();
    return sanitize(removed ?? current);
  }

  async function testConnection(agentId) {
    const current = profiles.getById(agentId);
    const resolvedId = current?.agent_id ?? agentId;
    const result = await gateway.testConnection(resolvedId);
    return { agent_id: resolvedId, status: result.status, gateway_url: result.gateway_url };
  }

  function buildProfile(input, current) {
    const role = input?.role ?? current?.role;
    const resolvedRole = normalizeRole(role);
    const resolvedId = current?.agent_id ?? resolveAgentId(input?.agent_id, resolvedRole);
    const enabled = input?.enabled === true;
    const status = normalizeStatus(input?.status ?? current?.status ?? (enabled ? "ready" : "not_connected"));
    const profile = {
      agent_id: resolvedId,
      agent_name: input?.agent_name ?? current?.agent_name ?? resolvedRole,
      role: resolvedRole,
      team: normalizeTeam(input?.team ?? current?.team ?? "Backend"),
      gateway_url: input?.gateway_url ?? current?.gateway_url ?? "https://gateway.example.test/agent",
      credential_ref: input?.credential_ref ?? current?.credential_ref ?? `runtime:${resolvedId}:api-key`,
      enabled,
      status,
      provider: input?.provider ?? current?.provider ?? "codex",
      model: input?.model ?? current?.model ?? "",
      ...(input?.reasoning ?? current?.reasoning ? { reasoning: input?.reasoning ?? current?.reasoning } : {}),
      ...(input?.use_responses ?? current?.use_responses !== undefined ? { use_responses: input?.use_responses ?? current?.use_responses } : {}),
      ...(input?.use_previous_response_id ?? current?.use_previous_response_id !== undefined ? { use_previous_response_id: input?.use_previous_response_id ?? current?.use_previous_response_id } : {}),
      created_at: current?.created_at ?? now(),
      updated_at: now()
    };
    validateAgent(profile);
    if (input?.api_key !== undefined) {
      if (typeof input.api_key !== "string" || input.api_key.length === 0) throw new ConfigurationError("API Key must be non-empty when provided.");
      secretStore.set(profile.credential_ref, input.api_key);
    }
    return profile;
  }
}

function sanitize(profile) {
  const safe = { ...profile };
  delete safe.api_key;
  if (safe.provider === undefined) safe.provider = "codex";
  if (safe.model === undefined) safe.model = "";
  return { ...safe, api_key_masked: "********" };
}

function validateAgent(profile) {
  if (typeof profile.agent_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profile.agent_id)) throw new ConfigurationError("Agent id must be a UUID.");
  if (typeof profile.agent_name !== "string" || profile.agent_name.length === 0) throw new ConfigurationError("Agent name is invalid.");
  if (typeof profile.gateway_url !== "string" || !profile.gateway_url.startsWith("https://")) throw new ConfigurationError("Gateway URL must use HTTPS.");
  if (!STATUSES.includes(profile.status)) throw new ConfigurationError("Status is invalid.");
  if (profile.provider !== undefined && !PROVIDERS.includes(profile.provider)) throw new ConfigurationError("Provider is invalid.");
  if (profile.model !== undefined && typeof profile.model !== "string") throw new ConfigurationError("Model must be a string.");
  if (profile.reasoning !== undefined && (!profile.reasoning || typeof profile.reasoning !== "object" || Array.isArray(profile.reasoning) || !["none", "low", "medium", "high", "max"].includes(profile.reasoning.effort))) throw new ConfigurationError("Reasoning effort is invalid.");
  if (profile.use_responses !== undefined && typeof profile.use_responses !== "boolean") throw new ConfigurationError("use_responses must be boolean.");
  if (profile.use_previous_response_id !== undefined && typeof profile.use_previous_response_id !== "boolean") throw new ConfigurationError("use_previous_response_id must be boolean.");
  if (!["coder", "reviewer", "sprint_leader", "architecture_manager"].includes(profile.role)) throw new ConfigurationError("Role is invalid.");
  normalizeTeam(profile.team);
}

function normalizeStatus(status) {
  if (!STATUSES.includes(status)) throw new ConfigurationError("Status is invalid.");
  return status;
}

function normalizeRole(role) {
  if (typeof role !== "string" || !["coder", "reviewer", "sprint_leader", "architecture_manager"].includes(role)) throw new ConfigurationError("Role is invalid.");
  return role;
}

function normalizeTeam(team) {
  if (typeof team !== "string" || team.length === 0 || team.length > 32 || !TEAMS.includes(team)) throw new ConfigurationError("Team is invalid.");
  return team;
}

function resolveAgentId(agentId, role) {
  if (agentId !== undefined && (typeof agentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId))) {
    throw new ConfigurationError("Agent id must be a UUID.");
  }
  return agentId ?? randomUUID();
}
