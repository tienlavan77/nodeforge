// Keep Coding agent panels independent of activity history for later persistence and layout integration.
const ROLES = new Set(["sprint_leader", "coder", "reviewer"]);

// Reject incomplete or malformed identity rather than attributing work by name or role.
function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

// Establish the stable project and agent identity shared by registry entries and rendering keys.
export function codingAgentPanelKey(projectId, agentId) {
  return validId(projectId) && validId(agentId) ? JSON.stringify([projectId, agentId]) : null;
}

// Resolve only a unique directory profile with consistent existing agent identity evidence.
export function codingAgentProfile(agents, agentId, projectId) {
  const matches = agents.filter((agent) => agent && (agent.agent_id === agentId || agent.id === agentId));
  if (matches.length !== 1) return null;
  const profile = matches[0];
  if (!validId(agentId) || (profile.agent_id !== undefined && profile.id !== undefined && profile.agent_id !== profile.id)) return null;
  if (profile.project_id !== undefined && profile.project_id !== projectId) return null;
  return ROLES.has(profile.role) ? profile : null;
}

// Require exact event scope and reject conflicting identity declarations before selecting actions.
function activityKey(event, projectId) {
  const payload = event?.payload;
  if (event?.event_type !== "agent.activity" || event.project_id !== projectId) return null;
  if (payload?.project_id !== undefined && payload.project_id !== projectId) return null;
  if (event.agent_id !== undefined && event.agent_id !== payload?.agent_id) return null;
  if (payload?.agentId !== undefined && payload.agentId !== payload.agent_id) return null;
  return codingAgentPanelKey(projectId, payload?.agent_id);
}

// Provide an in-memory registry boundary without implementing persistence or closed-panel policy.
export function createCodingAgentPanelRegistry() {
  return { panels: [], pending: {}, activity: {}, sourceStatus: "unknown" };
}

// Preserve unclosed identities while invalidating cached execution claims on source transitions.
export function setCodingAgentPanelSource(registry, sourceStatus) {
  return { ...registry, sourceStatus, activity: {} };
}

// Record working identities before buffer eviction and open once unique role evidence becomes available.
export function updateCodingAgentPanelRegistry(registry, projectId, events, agents) {
  const pending = { ...registry.pending };
  const activity = { ...registry.activity };
  const panels = [...registry.panels];
  for (const event of events) {
    const key = activityKey(event, projectId);
    if (!key) continue;
    if (event.payload.status === "working") pending[key] = { key, projectId, agentId: event.payload.agent_id };
    activity[key] = event.payload.status;
  }
  for (const entry of Object.values(pending)) {
    if (entry.projectId !== projectId || !codingAgentProfile(agents, entry.agentId, projectId)) continue;
    if (!panels.some((panel) => panel.key === entry.key)) panels.push(entry);
    delete pending[entry.key];
  }
  return { ...registry, panels, pending, activity };
}

// Isolate each panel's actions by exact project and agent identity, never by labels or roles.
export function codingAgentPanelActions(events, agents, projectId, agentId) {
  const key = codingAgentPanelKey(projectId, agentId);
  if (!key || !codingAgentProfile(agents, agentId, projectId)) return [];
  return events.filter((event) => activityKey(event, projectId) === key);
}

// Keep live activity evidence separate from directory status and cached panel existence.
export function codingAgentPanelStatus(registry, panel) {
  if (registry.sourceStatus !== "connected") return registry.sourceStatus === "error" ? "disconnected" : "unknown";
  return registry.activity[panel.key] ?? "unknown";
}
