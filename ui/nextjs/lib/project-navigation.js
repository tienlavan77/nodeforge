// Share project workspace URLs and remember the selection independently in each browser tab.
const STORAGE_KEY = "nodeforge:selected-project";
const globalRoutes = new Set(["system", "coding", "code", "agents"]);

// Build the owner-facing Architecture route from the persisted project identity.
export function projectArchitecturePath(projectId) {
  return projectId ? `/${encodeURIComponent(projectId)}` : "/";
}

// Open System conversations within the selected project's workspace.
export function projectSystemPath(projectId) {
  return projectId ? `${projectArchitecturePath(projectId)}/system` : "/";
}

// Open the Coding dashboard within the selected project's workspace.
export function projectCodingPath(projectId) {
  return projectId ? `${projectArchitecturePath(projectId)}/coding` : "/";
}

// Resolve explicit project routes before restoring any remembered browser selection.
export function projectIdFromPath(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  if (globalRoutes.has(segments[0])) return null;
  if (segments.length !== 1 && !(segments.length === 2 && ["system", "coding"].includes(segments[1]))) return null;
  try { return decodeURIComponent(segments[0]); }
  catch (error) { console.warn("Invalid project route encoding", error); return null; }
}

// Restore the tab's selected project for global System, Coding, and Agents navigation.
export function readSelectedProject() {
  try { return typeof window === "undefined" ? null : window.sessionStorage.getItem(STORAGE_KEY); }
  catch (error) { console.warn("Could not restore selected project", error); return null; }
}

// Remember an admitted selection without leaking it into another open browser tab.
export function rememberSelectedProject(projectId) {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(STORAGE_KEY, projectId); }
  catch (error) { console.warn("Could not remember selected project", error); }
}
