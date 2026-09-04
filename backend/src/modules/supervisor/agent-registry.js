import { ConfigurationError } from "../../shared/errors.js";

export function createAgentRegistry({ profiles = new Map(), adapters = new Map() } = {}) {
  return Object.freeze({ register, resolve });
  function register(agentId, adapter, config = {}) {
    if (!agentId || typeof adapter?.send !== "function") throw new ConfigurationError("Agent registry requires agent_id and send adapter.");
    profiles.set(agentId, config); adapters.set(agentId, adapter); return { agent_id: agentId, config };
  }
  function resolve(agentId) {
    const adapter = adapters.get(agentId);
    if (!adapter) throw new ConfigurationError(`Agent is not registered: ${agentId}`);
    return { adapter, config: profiles.get(agentId) ?? {} };
  }
}
