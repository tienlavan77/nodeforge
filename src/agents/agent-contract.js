import { ConfigurationError } from "../shared/errors.js";

export function createAgentContract(agent) {
  validateAgentContract(agent);
  return Object.freeze({
    id: agent.id,
    name: agent.name,
    canHandle: (task) => agent.canHandle(task),
    execute: async (context) => normalizeResult(await agent.execute(context))
  });
}

export function validateAgentContract(agent) {
  if (!agent || typeof agent !== "object") throw new ConfigurationError("Agent contract must be an object.");
  if (typeof agent.id !== "string" || agent.id.length === 0) throw new ConfigurationError("Agent contract requires id.");
  if (typeof agent.name !== "string" || agent.name.length === 0) throw new ConfigurationError("Agent contract requires name.");
  if (typeof agent.canHandle !== "function") throw new ConfigurationError("Agent contract requires canHandle(task).");
  if (typeof agent.execute !== "function") throw new ConfigurationError("Agent contract requires execute(context).");
  return true;
}

function normalizeResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.status !== "string" || result.status.length === 0) {
    throw new ConfigurationError("Agent execute() must return a result object with status.");
  }
  return Object.freeze({ ...result });
}
