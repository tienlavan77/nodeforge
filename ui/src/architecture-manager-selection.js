const STORAGE_KEY = "architecture-manager-selection";

function readState(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readArchitectureManagerAgent(projectId, storage = globalThis.localStorage) {
  if (projectId === undefined || projectId === null || projectId === "") return undefined;
  const entry = readState(storage)[String(projectId)];
  return entry && typeof entry === "object" ? entry.agent : undefined;
}

export function writeArchitectureManagerAgent(projectId, agentId, storage = globalThis.localStorage) {
  if (projectId === undefined || projectId === null || projectId === "") return;
  const state = readState(storage);
  const key = String(projectId);
  state[key] = { ...(state[key] && typeof state[key] === "object" ? state[key] : {}), agent: agentId };
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function architectureManagerSelection(projectId, fallback, storage = globalThis.localStorage) {
  const stored = readArchitectureManagerAgent(projectId, storage);
  return stored === undefined || stored === null ? fallback : stored;
}

export { STORAGE_KEY as ARCHITECTURE_MANAGER_STORAGE_KEY };
