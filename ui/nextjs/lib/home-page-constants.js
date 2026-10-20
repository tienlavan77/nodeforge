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
