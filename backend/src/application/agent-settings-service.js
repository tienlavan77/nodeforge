// Manages agent profiles, validation, and gateway connectivity.
// Aligns agent error retry semantics with UI normalization and redacts sensitive diagnostics.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { normalizeErrorContract } from "../shared/error-contract.js";

// Aligned with frontend ui-error and backend test-service retry semantics (non-retryable = client/config errors).
const NON_RETRYABLE_AGENT_CODES = new Set(["INPUT_INVALID", "TEST_JOB_NOT_FOUND", "TEST_JOB_FORBIDDEN", "CONFIGURATION_ERROR", "VALIDATION_ERROR"]);

// Redacts secrets, URLs and stack traces from agent error messages for safe display.
function redactAgentMessage(raw) {
  if (typeof raw !== "string") return raw ?? "Agent operation failed.";
  let text = raw.trim();
  if (!text) return "Agent operation failed.";
  text = text.split(/\n\s*at\s+/)[0].split(/stack trace/i)[0].trim();
  text = text.replace(/https?:\/\/[^\s]+/gi, "[REDACTED_URL]");
  text = text.replace(/(api[_-]?key|secret|token|password|authorization)[=:]\\s*[^\s]+/gi, "$1=[REDACTED]");
  text = text.replace(/Bearer [A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  if ((text.startsWith("{") || text.startsWith("[")) && text.length > 280) text = text.slice(0, 280);
  text = text.split(/\r?\n/)[0].replace(/\s+/g, " ").slice(0, 280);
  return text || "Agent operation failed.";
}

// Normalizes agent errors to a safe contract preserving request IDs and retry semantics aligned with UI.
export function normalizeAgentError(error, { requestId } = {}) {
  const source = typeof error === "string" ? { message: error } : error ?? {};
  const code = String(source.code ?? (typeof error === "string" ? "UNKNOWN" : "CONFIGURATION_ERROR")).toUpperCase();
  const retryable = source.retryable ?? !NON_RETRYABLE_AGENT_CODES.has(code);
  return normalizeErrorContract({ error: { ...source, code, message: redactAgentMessage(source.message ?? String(error ?? "")), retryable: Boolean(retryable) }, requestId: requestId ?? source.requestId, fallbackMessage: "Agent operation failed." });
}

const PROVIDERS = Object.freeze(["codex", "claude", "openai", "anthropic", "ollama", "custom", "xai", "alibaba", "zhipu", "deepseek"]);
const OPENAI_COMPATIBLE_PROVIDERS = new Set(["xai", "alibaba", "zhipu", "deepseek"]);
const STATUSES = Object.freeze(["ready", "working", "not_connected"]);
const TEAMS = Object.freeze(["Backend", "Frontend", "Security"]);
// Keep persisted agent.team values aligned with the Agents UI Team selector options.

// Creates a service for managing agent profiles and syncing gateway configuration.
export function createAgentSettingsService({ profiles, configuration, gateway, claudeSdkGateway, codexSdkGateway, openaiSdkGateway, ollamaSdkGateway, now = () => new Date().toISOString(), secretStore = new Map() } = {}) {
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
    const provider = String(current?.provider ?? "").toLowerCase();
    if (provider === "claude" || provider === "anthropic") {
      if (typeof claudeSdkGateway?.execute !== "function") throw new ConfigurationError("Claude SDK gateway is unavailable.");
      await claudeSdkGateway.execute({
        agentId: resolvedId,
        correlationId: `CONNECTION-${resolvedId}`,
        prompt: "Health check. Respond with OK."
      });
      return { agent_id: resolvedId, status: "CONNECTED", gateway_url: current.gateway_url };
    }
    if (provider === "codex") {
      if (typeof codexSdkGateway?.execute !== "function") throw new ConfigurationError("Codex SDK gateway is unavailable.");
      await codexSdkGateway.execute({
        agentId: resolvedId,
        correlationId: `CONNECTION-${resolvedId}`,
        prompt: "Health check. Respond with OK."
      });
      return { agent_id: resolvedId, status: "CONNECTED", gateway_url: current.gateway_url };
    }
    if (provider === "ollama") {
      if (typeof ollamaSdkGateway?.execute !== "function") throw new ConfigurationError("Ollama SDK gateway is unavailable.");
      await ollamaSdkGateway.execute({
        agent: current,
        correlationId: `CONNECTION-${resolvedId}`,
        prompt: "Health check. Respond with OK."
      });
      return { agent_id: resolvedId, status: "CONNECTED", gateway_url: current.gateway_url };
    }
    if (OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
      if (typeof openaiSdkGateway?.execute !== "function") throw new ConfigurationError("OpenAI-compatible SDK gateway is unavailable.");
      await openaiSdkGateway.execute({ agent: current, correlationId: `CONNECTION-${resolvedId}`, prompt: "Health check. Respond with OK." });
      return { agent_id: resolvedId, status: "CONNECTED", gateway_url: current.gateway_url };
    }
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

// Sanitizes agent profile by removing secrets and masking API keys.
function sanitize(profile) {
  const safe = { ...profile };
  delete safe.api_key;
  if (safe.provider === undefined) safe.provider = "codex";
  if (safe.model === undefined) safe.model = "";
  return { ...safe, api_key_masked: "********" };
}

// Validates agent profile fields against allowed values.
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
  if (!["coder", "reviewer", "sprint_leader", "architecture_manager", "linguist"].includes(profile.role)) throw new ConfigurationError("Role is invalid.");
  normalizeTeam(profile.team);
}

// Normalizes and validates agent status values.
function normalizeStatus(status) {
  if (!STATUSES.includes(status)) throw new ConfigurationError("Status is invalid.");
  return status;
}

// Normalizes and validates agent role values.
function normalizeRole(role) {
  if (typeof role !== "string" || !["coder", "reviewer", "sprint_leader", "architecture_manager", "linguist"].includes(role)) throw new ConfigurationError("Role is invalid.");
  return role;
}

// Normalizes and validates agent team values.
function normalizeTeam(team) {
  if (typeof team !== "string" || team.length === 0 || team.length > 32 || !TEAMS.includes(team)) throw new ConfigurationError("Team is invalid.");
  return team;
}

// Resolves or generates a UUID for the agent profile.
function resolveAgentId(agentId) {
  if (agentId !== undefined && (typeof agentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId))) {
    throw new ConfigurationError("Agent id must be a UUID.");
  }
  return agentId ?? randomUUID();
}
