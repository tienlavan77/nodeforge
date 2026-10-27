// Reads membership independently from workspace admission. A failed refresh preserves the last
// directory snapshot, while valid responses remain authoritative for membership and readiness.
import { lifecycleRequest } from "./project-lifecycle-client.js";

let snapshot = { projects: [], loaded: false, stale: false, error: null };
let generation = 0;
const listeners = new Set();

// Supply a stable membership snapshot without treating catalog entries as workspace admission.
export function getProjectDirectory() { return snapshot; }

// Notify directory views of successful refreshes and stale connectivity state.
export function subscribeProjectDirectory(listener) { listeners.add(listener); return () => listeners.delete(listener); }

// Publish directory state after validation, preserving cards on connection or response-format failures.
function publish(update) {
  snapshot = { ...snapshot, ...update };
  for (const listener of listeners) listener();
}

// Fence concurrent reads so an older directory response cannot undo the latest authoritative snapshot.
export async function refreshProjectDirectory() {
  const current = ++generation;
  try {
    const result = await lifecycleRequest("directory");
    if (result?.version !== "1" || !Array.isArray(result.projects) || result.projects.some((project) =>
      typeof project.project_id !== "string" || typeof project.root !== "string" ||
      !["ready", "unavailable"].includes(project.readiness))) throw new Error("Invalid backend directory response.");
    if (current === generation) publish({ projects: result.projects, loaded: true, stale: false, error: null });
    return result.projects;
  } catch (error) {
    if (current === generation) publish({ stale: true, error: error.message });
    throw error;
  }
}
