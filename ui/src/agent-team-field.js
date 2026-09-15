// Shared Agents-page team field definition.
// Kept in a small module so create and save forms use the same options and validation.
export const AGENT_TEAM_OPTIONS = Object.freeze(["Backend", "Frontend", "Security"]);

export function normalizeAgentTeam(team) {
  if (typeof team !== "string" || team.length === 0 || team.length > 32 || !AGENT_TEAM_OPTIONS.includes(team)) {
    throw new Error("Team is invalid.");
  }
  return team;
}
