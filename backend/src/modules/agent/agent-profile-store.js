import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const profileSchema = require("../../../schemas/governance/agent-profile.schema.json");
const SECRET_FIELD = /(?:api[_-]?key|credential(?!_ref)|secret|password|token|authorization)/i;

export function createAgentProfileStore({ validateProfile = createValidator(), database } = {}) {
  if (typeof validateProfile !== "function") throw new ConfigurationError("Agent Profile validation must be a function.");
  if (database !== undefined && (!database?.run || !database?.all)) throw new ConfigurationError("Persistent Agent Profile Store requires a SQLite database.");
  const profiles = [];
  const byId = new Map();
  if (database) load();

  return Object.freeze({ create, update, getById, getAll, load });

  function create(input) {
    const profile = normalize(input);
    validateProfile(profile);
    if (byId.has(profile.agent_id)) throw new ConfigurationError(`Agent Profile already exists: ${profile.agent_id}.`);
    persist(profile, "INSERT INTO agent_profiles (agent_id, profile_json) VALUES (?, ?)");
    profiles.push(freeze(profile));
    byId.set(profile.agent_id, profiles.at(-1));
    return clone(profile);
  }

  function update(input) {
    const profile = normalize(input);
    const existing = byId.get(profile.agent_id);
    if (!existing) throw new ConfigurationError(`Unknown Agent Profile: ${profile.agent_id}.`);
    const updated = { ...profile, created_at: existing.created_at };
    validateProfile(updated);
    if (database) database.run("UPDATE agent_profiles SET profile_json = ? WHERE agent_id = ?", [JSON.stringify(updated), updated.agent_id]);
    const stored = freeze(updated);
    profiles[profiles.findIndex(({ agent_id: id }) => id === updated.agent_id)] = stored;
    byId.set(updated.agent_id, stored);
    return clone(stored);
  }

  function getById(agentId) {
    assertId(agentId);
    const profile = byId.get(agentId);
    return profile ? clone(profile) : undefined;
  }

  function getAll() { return profiles.map(clone); }

  function load() {
    ensureTable(database);
    profiles.splice(0, profiles.length); byId.clear();
    for (const { profile_json } of database.all("SELECT profile_json FROM agent_profiles ORDER BY sequence")) {
      const profile = freeze(JSON.parse(profile_json)); profiles.push(profile); byId.set(profile.agent_id, profile);
    }
    return getAll();
  }

  function persist(profile, sql) {
    if (database) database.run(sql, [profile.agent_id, JSON.stringify(profile)]);
  }
}

function normalize(input) {
  if (!input || typeof input !== "object") throw new ConfigurationError("Agent Profile is required.");
  if (Object.keys(input).some((key) => SECRET_FIELD.test(key))) throw new ConfigurationError("Agent Profile cannot contain plaintext credentials.");
  const profile = structuredClone(input);
  if (!profile.status) profile.status = profile.enabled ? "configured" : "disabled";
  validateTimestamp(profile.created_at, "created_at"); validateTimestamp(profile.updated_at, "updated_at");
  return profile;
}

function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv); const validate = ajv.compile(profileSchema);
  return (profile) => { if (!validate(profile)) throw new ConfigurationError(`Invalid Agent Profile: ${ajv.errorsText(validate.errors, { separator: "; " })}`); return true; };
}

function ensureTable(database) {
  database.run("CREATE TABLE IF NOT EXISTS agent_profiles (sequence INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL UNIQUE, profile_json TEXT NOT NULL)");
}
function freeze(profile) { return Object.freeze(structuredClone(profile)); }
function clone(profile) { return structuredClone(profile); }
function assertId(id) { if (typeof id !== "string" || id.length === 0) throw new ConfigurationError("An Agent Profile id is required."); }
function validateTimestamp(value, field) { if (typeof value !== "string" || value.length === 0) throw new ConfigurationError(`Agent Profile ${field} is required.`); }
