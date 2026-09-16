export const PROJECT_AGENT_PREFERENCES_KEY = "architecture-manager-selection";

export function createProjectAgentPreferencesService(storage) {
  const readStored = () => {
    const value = storage.getItem("arch");
    if (!value) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  const writeStored = (projectId, agent) => {
    storage.setItem("arch", JSON.stringify({ ...readStored(), [projectId]: { agent } }));
  };

  return {
    read: (projectId) => readStored()[projectId]?.agent || null,
    write: writeStored
  };
}

function createProjectAgentPreferencesService({ storage }) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    throw new TypeError("Project agent preferences require localStorage-compatible storage.");
  }

  function read(projectId) {
    if (projectId === undefined || projectId === null || projectId === "") return undefined;
    const state = parse(storage.getItem(PROJECT_AGENT_PREFERENCES_KEY));
    const entry = state[String(projectId)];
    return entry && typeof entry === "object" ? entry.agent : undefined;
  }

  function write(projectId, agentId) {
    if (projectId === undefined || projectId === null || projectId === "") return;
    const state = parse(storage.getItem(PROJECT_AGENT_PREFERENCES_KEY));
    const key = String(projectId);
    state[key] = { ...(state[key] && typeof state[key] === "object" ? state[key] : {}), agent: agentId };
    storage.setItem(PROJECT_AGENT_PREFERENCES_KEY, JSON.stringify(state));
  }

  return Object.freeze({ read, write });
}

function parse(raw) {
  try {
    const value = raw ? JSON.parse(raw) : {};
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
