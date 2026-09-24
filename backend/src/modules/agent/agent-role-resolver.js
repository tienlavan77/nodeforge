// Resolves the best available agent profile for a given role by readiness and creation order.
import { ConfigurationError } from "../../shared/errors.js";

const ROLES = new Set(["coder", "reviewer", "sprint_leader", "architecture_manager", "linguist"]);
const USABLE_STATUSES = new Set(["ready"]);

// Creates a resolver that picks the earliest ready profile for a role.
export function createAgentRoleResolver({ profiles } = {}) {
  if (typeof profiles?.getAll !== "function") throw new ConfigurationError("Agent Role Resolver requires an Agent Profile Store.");

  return Object.freeze({ resolve, resolveProfile, resolveAvailable, list });

// Resolves an agent id for the given role, throwing when none is available.
  function resolve(role) {
    return resolveProfile(role).agent_id;
  }

// Resolves the full usable profile for the given role.
  function resolveProfile(role) {
    assertRole(role);
    const profile = select(profiles.getAll().filter((candidate) => candidate.role === role));
    if (!profile) throw Object.assign(new ConfigurationError(`No usable Agent Profile found for role: ${role}.`), { code: "AGENT_ROLE_NOT_AVAILABLE", role });
    return structuredClone(profile);
  }

// Returns the best matching profile or undefined without throwing.
  function resolveAvailable(requiredRole) {
    if (requiredRole !== undefined) assertRole(requiredRole);
    const profile = select(profiles.getAll().filter((candidate) => requiredRole === undefined || candidate.role === requiredRole));
    return profile ? structuredClone(profile) : undefined;
  }

// Lists all profiles, optionally filtered by role.
  function list(role) {
    if (role !== undefined) assertRole(role);
    return profiles.getAll()
      .filter((profile) => role === undefined || profile.role === role)
      .map((profile) => structuredClone(profile));
  }
}

// Picks the earliest ready and enabled profile as the preferred candidate.
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

// Validates that the requested role is in the supported set.
function assertRole(role) {
  if (typeof role !== "string" || !ROLES.has(role)) throw new ConfigurationError(`Unsupported Agent role: ${role}.`);
}
