// Keep workspace requests and streams isolated to the explicitly selected managed project.
import { forgeV1 } from "./node-client-url.js";
import { requestJson } from "./node-client-request.js";

let snapshot = { projects: [], projectId: null, generation: 0, loaded: false, error: null };
const listeners = new Set();
const streams = new Set();
let refreshGeneration = 0;

// Read the current managed project selection without choosing an implicit fallback.
export function getProjectSelection() { return snapshot; }

// Subscribe workspace components to selection changes and management errors.
export function subscribeProjectSelection(listener) { listeners.add(listener); return () => listeners.delete(listener); }

// Publish a new selection and close every subscription belonging to the previous workspace.
function publish(update) {
  const changed = update.projectId !== undefined && update.projectId !== snapshot.projectId;
  snapshot = { ...snapshot, ...update, generation: snapshot.generation + (changed ? 1 : 0) };
  if (changed) {
    for (const stream of streams) {
      try { stream.close(); }
      catch (error) { console.error("Could not close the previous project stream", error); }
    }
    streams.clear();
  }
  for (const listener of listeners) listener();
}

// Require a deliberate selection after an established project becomes unavailable.
export function selectProject(projectId) {
  if (!snapshot.projects.some((project) => project.project_id === projectId)) throw new Error("Select an available project.");
  publish({ projectId, error: null });
}

// Refresh admitted identities and automatically use only the initial single-project configuration.
export async function refreshProjects() {
  const refresh = ++refreshGeneration;
  try {
    const result = await requestJson(forgeV1("/lifecycle/list"), { cache: "no-store" });
    if (refresh !== refreshGeneration) return;
    const projects = result.projects ?? [];
    const missing = snapshot.projectId && !projects.some((project) => project.project_id === snapshot.projectId);
    const projectId = missing ? null : snapshot.projectId ?? (!snapshot.loaded && projects.length === 1 ? projects[0].project_id : null);
    publish({ projects, projectId, loaded: true, error: missing ? "Selected project is unavailable. Refresh or select an available project." : null });
  } catch (error) {
    if (refresh === refreshGeneration) publish({ projectId: null, loaded: true, error: error.message });
    throw error;
  }
}

// Add a managed root through the strict existing lifecycle contract, then refresh selectable identities.
export async function addProject(root) {
  const result = await requestJson(forgeV1("/lifecycle/add"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root })
  });
  await refreshProjects();
  return result;
}

// Remove a managed root without silently routing its workspace to a different project.
export async function removeProject(root) {
  const result = await requestJson(forgeV1("/lifecycle/remove"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root })
  });
  await refreshProjects();
  return result;
}

// Reject obsolete workspace callbacks before they can submit work or publish stale results.
function assertCurrent(selection) {
  if (selection.generation !== snapshot.generation || selection.projectId !== snapshot.projectId) {
    throw Object.assign(new Error("Project selection changed. Retry in the current workspace."), { code: "STALE_PROJECT_SELECTION" });
  }
}

const globalOperations = new Set(["getAgents", "getAgent", "createAgent", "saveAgentSettings", "testAgentConnection", "sendOwnerMessage"]);
const objectOperations = new Set(["createConversation", "listConversations", "postHumanDecision", "getConversationAuditHistory", "postOwnerMessage", "getConversationMessages", "saveConversationMarkdown", "connectConversationStream", "sendOwnerMessage", "connectProjectStream"]);

// Bind existing operation-specific request shapes and callbacks to one immutable selection generation.
export function bindProjectClient(client) {
  const selection = snapshot;
  if (!selection.loaded) return client;
  const bound = Object.fromEntries(Object.entries(client).map(([name, operation]) => [name, typeof operation !== "function" ? operation : (...args) => {
    assertCurrent(selection);
    if (!globalOperations.has(name)) {
      if (!selection.projectId) throw new Error("Select an available project before continuing.");
      if (objectOperations.has(name) || (args[0] && typeof args[0] === "object" && "projectId" in args[0])) {
        const options = { ...args[0], projectId: selection.projectId };
        for (const key of Object.keys(options)) {
          if (typeof options[key] === "function") {
            const callback = options[key];
            options[key] = (...values) => { if (selection.generation === snapshot.generation) callback(...values); };
          }
        }
        args[0] = options;
      } else args[0] = selection.projectId;
    }
    const result = operation.apply(bound, args);
    if (result?.close) {
      const stream = { ...result, close: () => { streams.delete(stream); result.close(); } };
      streams.add(stream);
      return stream;
    }
    if (!result?.then) return result;
    return result.then((value) => { assertCurrent(selection); return value; }, (error) => {
      assertCurrent(selection);
      if (["PROJECT_NOT_FOUND", "PROJECT_UNAVAILABLE", "PROJECT_NOT_ADMITTED"].includes(String(error.code).toUpperCase())) {
        publish({ projectId: null, error: "Selected project is unavailable. Refresh or select an available project." });
      }
      throw error;
    });
  }]));
  return Object.freeze(bound);
}
