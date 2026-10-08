// Show each workspace only the activity of agents assigned to its business role.

// Filter project-wide activity events by one or more configured agent roles.
export function monitorAgentActivities(events, agents, roles) {
  const agentRoles = new Map(agents.map((agent) => [agent.agent_id ?? agent.id, agent.role]));
  const allowedRoles = new Set(Array.isArray(roles) ? roles : [roles]);
  return events.filter((event) => allowedRoles.has(agentRoles.get(event.payload?.agent_id)));
}
