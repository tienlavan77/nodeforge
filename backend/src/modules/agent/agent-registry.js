// In-memory registry for agent descriptors with role validation and contract enforcement.
import { ConfigurationError } from "../../shared/errors.js";
import { validateAgentContract } from "../../agents/agent-contract.js";

const AGENT_ROLES = new Set(["architecture_manager", "sprint_leader", "runtime", "coder", "reviewer", "builder", "linguist"]);

// Creates the in-memory agent registry with register/get/list semantics.
export function createAgentRegistry() {
  const agents = new Map();

  return Object.freeze({ register, unregister, get, has, list });

// Validates and registers an agent descriptor, enforcing role and uniqueness constraints.
  function register(agent) {
    validateAgentContract(agent);
    if (agent.role !== undefined && !AGENT_ROLES.has(agent.role)) {
      throw new ConfigurationError(`Unsupported Agent role: ${agent.role}.`);
    }
    if (agents.has(agent.id)) throw new ConfigurationError(`Agent already registered: ${agent.id}.`);
    const stored = Object.freeze({ ...agent });
    agents.set(stored.id, stored);
    return cloneAgent(stored);
  }

// Removes an agent by id and returns whether it was present.
  function unregister(id) {
    assertId(id);
    return agents.delete(id);
  }

// Returns a cloned agent by id or undefined.
  function get(id) {
    assertId(id);
    const agent = agents.get(id);
    return agent ? cloneAgent(agent) : undefined;
  }

// Checks whether an agent with the given id is registered.
  function has(id) {
    assertId(id);
    return agents.has(id);
  }

// Returns cloned copies of all registered agents.
  function list() {
    return [...agents.values()].map(cloneAgent);
  }
}

// Validates that an agent id is a non-empty string.
function assertId(id) {
  if (typeof id !== "string" || id.length === 0) throw new ConfigurationError("An Agent id is required.");
}

// Returns a shallow clone of an agent descriptor for safe external use.
function cloneAgent(agent) {
  return { ...agent };
}
