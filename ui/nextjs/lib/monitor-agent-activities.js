// Show each workspace only the activity of agents assigned to its business role.

// Filter project-wide activity events by the agent directory's configured role.
export function monitorAgentActivities(events, agents, role) {
  const agentRoles = new Map(agents.map((agent) => [agent.agent_id ?? agent.id, agent.role]));
  return events.filter((event) => agentRoles.get(event.payload?.agent_id) === role);
}
