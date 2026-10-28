// Project id and session/local-storage keys shared by the NodeForge home workspace page.

import { getProjectSelection, subscribeProjectSelection } from "./project-selection.js";

export let PROJECT_ID = "PROJECT-NODEFORGE";
export const ARCHITECTURE_CONVERSATION_ID = "CONV-ARCHITECTURE";
export let SPRINT_CACHE_KEY = `nodeforge:sprints:${PROJECT_ID}`;
export let CHAT_STATE_KEY = `nodeforge:chat:last:${PROJECT_ID}`;

// Partition restored conversation and sprint state by the admitted workspace identity.
function updateProjectKeys() {
  PROJECT_ID = getProjectSelection().projectId ?? "";
  SPRINT_CACHE_KEY = `nodeforge:sprints:${PROJECT_ID}`;
  CHAT_STATE_KEY = `nodeforge:chat:last:${PROJECT_ID}`;
}
subscribeProjectSelection(updateProjectKeys);

// Business purpose: resolves the active route-scoped `projectId` for `ArchitectureWorkspace` and child screens (`/[projectId]/coding`, `/[projectId]/system`) so URL parameters take precedence over global fallback constants.
// Technical description: returns the first non-empty string among `explicitProjectId`, `routeParams?.projectId`, `projectIdFromPath(pathname)`, `getProjectSelection().projectId`, and `PROJECT_ID`.
export function resolveActiveProjectId({ explicitProjectId, routeProjectId, pathname } = {}) {
  for (const candidate of [explicitProjectId, routeProjectId]) {
    if (typeof candidate === "string" && candidate.trim()) {
      try { return decodeURIComponent(candidate.trim()); }
      catch { return candidate.trim(); }
    }
  }
  if (typeof pathname === "string" && pathname.startsWith("/")) {
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !["system", "coding", "code", "agents", "control-api"].includes(segments[0])) {
      try { return decodeURIComponent(segments[0]); }
      catch { return segments[0]; }
    }
  }
  return getProjectSelection().projectId || PROJECT_ID || "PROJECT-NODEFORGE";
}
