import { ConfigurationError } from "../../shared/errors.js";

const ROLES = new Set(["coder", "reviewer", "sprint_leader", "architecture_manager"]);
const USABLE_STATUSES = new Set(["ready"]);

export function createAgentRoleResolver({ profiles } = {}) {
  if (typeof profiles?.getAll !== "function") throw new ConfigurationError("Agent Role Resolver requires an Agent Profile Store.");

  return Object.freeze({ resolve, resolveProfile, resolveAvailable, list });

  function resolve(role) {
    return resolveProfile(role).agent_id;
  }

  function resolveProfile(role) {
    assertRole(role);
    const profile = select(profiles.getAll().filter((candidate) => candidate.role === role));
    if (!profile) throw Object.assign(new ConfigurationError(`No usable Agent Profile found for role: ${role}.`), { code: "AGENT_ROLE_NOT_AVAILABLE", role });
    return structuredClone(profile);
  }

  function resolveAvailable(requiredRole) {
    if (requiredRole !== undefined) assertRole(requiredRole);
    const profile = select(profiles.getAll().filter((candidate) => requiredRole === undefined || candidate.role === requiredRole));
    return profile ? structuredClone(profile) : undefined;
  }

  function list(role) {
    if (role !== undefined) assertRole(role);
    return profiles.getAll()
      .filter((profile) => role === undefined || profile.role === role)
      .map((profile) => structuredClone(profile));
  }
}

function select(profiles) {
  return profiles
    .filter((profile) => profile?.enabled === true && USABLE_STATUSES.has(profile.status))
    .sort((left, right) => {
      const statusOrder = Number(right.status === "ready") - Number(left.status === "ready");
      if (statusOrder) return statusOrder;
      const createdOrder = String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""));
      return createdOrder || String(left.agent_id).localeCompare(String(right.agent_id));
    })[0];
}

function assertRole(role) {
  if (typeof role !== "string" || !ROLES.has(role)) throw new ConfigurationError(`Unsupported Agent role: ${role}.`);
}
