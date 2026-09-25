// Converts raw sprint-plan API data into the dashboard shape the home workspace renders, with a session-cache fallback for instant reloads.

import { PROJECT_ID, SPRINT_CACHE_KEY } from "./home-page-constants.js";

// Converts raw sprint plans into dashboard view data.
export function toDashboard(sprintPlans) {
  const plans = Array.isArray(sprintPlans) ? sprintPlans : sprintPlans?.items ?? sprintPlans?.sprints ?? [];
  return { project_id: PROJECT_ID, roadmap: { id: plans[0]?.roadmap_id ?? `ROADMAP-${PROJECT_ID}`, version: plans.at(-1)?.id ?? "latest", sprints: plans.map((sprint, index) => ({ id: sprint.id, objective: sprint.objective, order: index + 1, status: sprint.status ?? "planned", tasks: (sprint.tickets ?? []).map((ticket) => ({ ...ticket, status: ticket.status ?? "planned", progress: ticket.status === "done" ? 100 : ticket.status === "running" || ticket.status === "reviewing" ? 50 : 0 })) })) } };
}

// Reads cached sprint plan data from storage.
export function readSprintCache() {
  if (typeof window === "undefined") return null;
  try { return toDashboard(JSON.parse(window.sessionStorage.getItem(SPRINT_CACHE_KEY) ?? "null")); } catch { return null; }
}
