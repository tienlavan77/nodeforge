import { createAgentContract } from "../../agents/agent-contract.js";
import { ConfigurationError } from "../../shared/errors.js";
import { createAgentRegistry } from "./agent-registry.js";

export function createAgentBootstrap({ registry = createAgentRegistry(), bus, architectureManager, architectureManagerAdapter, sprintLeader, runtime, builder, reviewer, sessionStore, recovery, replayEngine, eventStore } = {}) {
  if (typeof bus?.send !== "function") throw new ConfigurationError("Agent Bootstrap requires the shared Communication Bus.");
  if (!architectureManager || typeof architectureManager.createArchitecturePlan !== "function") throw new ConfigurationError("Agent Bootstrap requires an Architecture Manager.");
  if (architectureManagerAdapter !== undefined && typeof architectureManagerAdapter?.handle !== "function") throw new ConfigurationError("Architecture Manager Adapter must provide handle().");
  if (!sprintLeader || typeof sprintLeader.generateTickets !== "function") throw new ConfigurationError("Agent Bootstrap requires a Sprint Leader Planner.");
  if (!runtime || typeof runtime.startTask !== "function") throw new ConfigurationError("Agent Bootstrap requires a Runtime Service.");
  const agents = [
    managerAgent(architectureManager, architectureManagerAdapter),
    leaderAgent(sprintLeader),
    runtimeAgent(runtime),
    requireContract(builder, "Builder"),
    requireContract(reviewer, "Reviewer")
  ];

  const registered = [];
  for (const agent of agents) {
    if (!registry.has(agent.id)) registered.push(registry.register(agent));
    else registered.push(registry.get(agent.id));
  }

  const recoveredSessions = sessionStore && recovery?.recover ? recovery.recover().recoveredSessions : [];
  const replayed = sessionStore && replayEngine?.replay && eventStore?.getAll ? replayEngine.replay(eventStore.getAll()) : undefined;
  return Object.freeze({ registry, bus, agents: Object.freeze(registered), recoveredSessions: Object.freeze(recoveredSessions.map((session) => structuredClone(session))), ...(replayed ? { replayedState: structuredClone(replayed.state) } : {}), persistSession });

  function persistSession(agentId, session, metadata = {}) {
    if (typeof sessionStore?.save !== "function") throw new ConfigurationError("Persistent Agent Session Store is required.");
    if (!registry.has(agentId)) throw new ConfigurationError(`Unknown Agent: ${agentId}.`);
    return sessionStore.save(session, { ...metadata, agent_id: agentId });
  }
}

function managerAgent(manager, adapter) {
  return withRole(createAgentContract({
    id: "architecture-manager",
    name: "Architecture Manager",
    role: "architecture-manager",
    canHandle: (task) => task?.role === "architecture-manager" || task?.type === "architecture",
    async execute({ operation = "createArchitecturePlan", ...input } = {}) {
      if (typeof manager[operation] !== "function") throw new ConfigurationError(`Unknown Architecture Manager operation: ${operation}.`);
      return { status: "completed", result: manager[operation](input) };
    }
  }), "architecture-manager", adapter);
}

function leaderAgent(leader) {
  return withRole(createAgentContract({
    id: "sprint-leader",
    name: "Sprint Leader",
    role: "sprint-leader",
    canHandle: (task) => task?.role === "sprint-leader" || task?.type === "sprint-planning",
    async execute({ operation = "generateTickets", tickets, ...input } = {}) {
      if (typeof leader[operation] !== "function") throw new ConfigurationError(`Unknown Sprint Leader operation: ${operation}.`);
      const result = operation === "prioritizeBacklog" ? leader[operation](tickets) : leader[operation](input);
      return { status: "completed", result };
    }
  }), "sprint-leader");
}

function runtimeAgent(runtime) {
  return withRole(createAgentContract({
    id: "runtime",
    name: "Agent Runtime",
    role: "runtime",
    canHandle: (task) => task?.role === "runtime" || task?.type === "runtime",
    async execute({ operation = "startTask", ...input } = {}) {
      if (typeof runtime[operation] !== "function") throw new ConfigurationError(`Unknown Runtime operation: ${operation}.`);
      return { status: "completed", result: runtime[operation](input) };
    }
  }), "runtime");
}

function requireContract(agent, label) {
  if (!agent || typeof agent.canHandle !== "function" || typeof agent.execute !== "function") {
    throw new ConfigurationError(`${label} Agent Contract is required.`);
  }
  return Object.freeze({ ...agent, role: label.toLowerCase() });
}

function withRole(agent, role, runtimeAdapter) {
  return Object.freeze({ ...agent, role, ...(runtimeAdapter ? { runtimeAdapter } : {}) });
}
