import { ConfigurationError } from "../../shared/errors.js";
import { validateAgentContract } from "../../agents/agent-contract.js";

const AGENT_ROLES = new Set(["architecture-manager", "sprint-leader", "runtime", "builder", "reviewer"]);

export function createAgentRegistry() {
  const agents = new Map();

  return Object.freeze({ register, unregister, get, has, list });

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

  function unregister(id) {
    assertId(id);
    return agents.delete(id);
  }

  function get(id) {
    assertId(id);
    const agent = agents.get(id);
    return agent ? cloneAgent(agent) : undefined;
  }

  function has(id) {
    assertId(id);
    return agents.has(id);
  }

  function list() {
    return [...agents.values()].map(cloneAgent);
  }
}

function assertId(id) {
  if (typeof id !== "string" || id.length === 0) throw new ConfigurationError("An Agent id is required.");
}

function cloneAgent(agent) {
  return { ...agent };
}
