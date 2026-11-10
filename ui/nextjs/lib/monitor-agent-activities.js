// Show each workspace only the activity of agents assigned to its business role.

// Filter project-wide activity events by one or more configured agent roles.
export function monitorAgentActivities(events, agents, roles, selectedAgentId) {
  const agentRoles = new Map(agents.map((agent) => [agent.agent_id ?? agent.id, agent.role]));
  const allowedRoles = new Set(Array.isArray(roles) ? roles : [roles]);
  return events.filter((event) => {
    const rawId = event.payload?.agent_id;
    const baseId = typeof rawId === "string" && rawId.includes(":sub:") ? rawId.split(":sub:")[0] : (event.payload?.parent_agent_id ?? rawId);
    const role = agentRoles.get(rawId) ?? agentRoles.get(baseId);
    return allowedRoles.has(role) && (selectedAgentId === undefined || (Boolean(selectedAgentId) && (rawId === selectedAgentId || baseId === selectedAgentId)));
  });
}
