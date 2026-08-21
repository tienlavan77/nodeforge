import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";

const REQUIRED_FIELDS = ["agent_id", "agent_name", "gateway_url", "credential_ref", "enabled", "status", "created_at", "updated_at"];
const OPTIONAL_FIELDS = ["provider", "model"];
const FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
const PROVIDERS = ["codex", "claude", "openai", "anthropic", "custom", "devquote"];
const SECRET_FIELD = /(?:api[_-]?key|credential(?!_ref)|secret|password|token|authorization)/i;

// A derived local Node projection; Agent Profile Store remains the authority.
export function createNodeAgentConfiguration({ profiles, configurationPath } = {}) {
  if (typeof profiles?.getAll !== "function" || typeof profiles?.getById !== "function") throw new ConfigurationError("Node Agent Configuration requires an Agent Profile Store.");
  if (typeof configurationPath !== "string" || configurationPath.length === 0) throw new ConfigurationError("Node Agent Configuration requires a configuration path.");
  let configurations = loadFile();

  return Object.freeze({ sync, getById, getAll, reload });

  function sync() {
    const source = profiles.getAll();
    const next = source.map(project).sort((left, right) => left.agent_id.localeCompare(right.agent_id));
    write(next);
    configurations = freezeAll(next);
    return getAll();
  }

  function reload() {
    configurations = loadFile();
    return getAll();
  }

  function getById(agentId) {
    assertId(agentId);
    const value = configurations.find((item) => item.agent_id === agentId);
    return value ? structuredClone(value) : undefined;
  }

  function getAll() { return configurations.map((item) => structuredClone(item)); }

  function loadFile() {
    if (!existsSync(configurationPath)) return Object.freeze([]);
    try {
      const parsed = JSON.parse(readFileSync(configurationPath, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("configuration must be an array");
      return freezeAll(parsed.map(validateConfiguration));
    } catch (error) {
      throw new ConfigurationError(`Invalid Node Agent Configuration: ${error.message}`);
    }
  }

  function write(next) {
    mkdirSync(dirname(configurationPath), { recursive: true, mode: 0o700 });
    const temporary = `${configurationPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, configurationPath);
  }
}

function project(profile) {
  if (!profile || typeof profile !== "object" || Object.keys(profile).some((key) => SECRET_FIELD.test(key))) throw new ConfigurationError("Agent Profile contains plaintext credentials.");
  const projected = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, profile[field]]));
  for (const field of OPTIONAL_FIELDS) if (profile[field] !== undefined) projected[field] = profile[field];
  return validateConfiguration(projected);
}

function validateConfiguration(value) {
  if (!value || typeof value !== "object"
    || REQUIRED_FIELDS.some((field) => value[field] === undefined)
    || Object.keys(value).some((key) => !FIELDS.includes(key))
    || typeof value.agent_id !== "string" || typeof value.gateway_url !== "string" || !value.gateway_url.startsWith("https://")
    || typeof value.credential_ref !== "string" || !value.credential_ref || typeof value.enabled !== "boolean") throw new ConfigurationError("Agent configuration is invalid.");
  if (value.provider !== undefined && !PROVIDERS.includes(value.provider)) throw new ConfigurationError("Agent configuration is invalid.");
  if (value.model !== undefined && typeof value.model !== "string") throw new ConfigurationError("Agent configuration is invalid.");
  if (Object.keys(value).some((key) => SECRET_FIELD.test(key))) throw new ConfigurationError("Agent configuration cannot contain plaintext credentials.");
  const result = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, value[field]]));
  for (const field of OPTIONAL_FIELDS) if (value[field] !== undefined) result[field] = value[field];
  return result;
}

function freezeAll(values) { return Object.freeze(values.map((value) => Object.freeze(structuredClone(value)))); }
function assertId(value) { if (typeof value !== "string" || value.length === 0) throw new ConfigurationError("An Agent configuration id is required."); }
