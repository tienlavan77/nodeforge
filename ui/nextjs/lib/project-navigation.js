// Share project workspace URLs and remember the selection independently in each browser tab.
const STORAGE_KEY = "nodeforge:selected-project";
const globalRoutes = new Set(["system", "coding", "code", "agents"]);
const UUID_PROJECT_ID_PATTERN = /^PROJECT-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Business purpose: normalizes a human-readable project name or root directory basename into a URL-safe slug so UUID-based project IDs can be displayed as readable project names in browser URLs.
// Technical description: strips diacritics, converts `đ/Đ` to `d`, lowercases alphanumeric tokens separated by single hyphens, and avoids reserved system routes by appending `-project`.
export function toProjectSlug(value) {
  if (typeof value !== "string") return "";
  const slug = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!slug) return "";
  return globalRoutes.has(slug) || ["forge", "control-api", "lifecycle", "projects", "api", "_next"].includes(slug)
    ? `${slug}-project`
    : slug;
}

// Business purpose: derives a friendly route segment for a project record or ID, mapping opaque `PROJECT-<uuid>` identifiers to the project's human-readable name slug while keeping explicit custom IDs intact.
// Technical description: inspects a project object or matches a project ID against an optional project list; if the ID matches `PROJECT-<uuid>`, returns the normalized slug from `name`, `title`, or `root` basename.
export function resolveProjectRouteSlug(projectOrId, projects = []) {
  if (!projectOrId) return "";
  const record = typeof projectOrId === "object"
    ? projectOrId
    : Array.isArray(projects)
      ? projects.find((item) => item && (item.project_id === projectOrId || item.projectId === projectOrId || item.slug === projectOrId))
      : null;
  const rawId = typeof projectOrId === "object"
    ? String(projectOrId.project_id ?? projectOrId.projectId ?? "").trim()
    : String(projectOrId).trim();
  if (record?.slug && UUID_PROJECT_ID_PATTERN.test(rawId)) return record.slug;
  if (UUID_PROJECT_ID_PATTERN.test(rawId) && record) {
    const candidateName = record.name || record.title || String(record.root ?? "").split("/").filter(Boolean).at(-1) || "";
    const derived = toProjectSlug(candidateName);
    if (derived) return derived;
  }
  return rawId;
}

// Build the owner-facing Architecture route from the persisted project identity or friendly slug.
export function projectArchitecturePath(projectId, projects) {
  const segment = resolveProjectRouteSlug(projectId, projects);
  return segment ? `/${encodeURIComponent(segment)}` : "/";
}

// Open System conversations within the selected project's workspace.
export function projectSystemPath(projectId, projects) {
  return projectId ? `${projectArchitecturePath(projectId, projects)}/system` : "/";
}

// Open the Coding dashboard within the selected project's workspace.
export function projectCodingPath(projectId, projects) {
  return projectId ? `${projectArchitecturePath(projectId, projects)}/coding` : "/";
}

// Business purpose: keeps the global Agents management page and the public project directory
// independent from project workspace admission so opening /agents never calls /lifecycle/list
// or blocks the page when no project is selected.
// Technical description: returns true for the root directory ("/") and any "/agents" route
// so ProjectRouteBoundary renders their children directly without mounting ProjectWorkspace.
export function isProjectIndependentPath(pathname) {
  return pathname === "/" || pathname === "/agents" || String(pathname ?? "").startsWith("/agents/");
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

// Business purpose: preserves the active project identity across global pages like `/agents`
// while letting an explicit route project override any previously remembered tab selection.
// Technical description: returns the first non-empty trimmed string among `explicitProjectId`,
// `projectIdFromPath(pathname)`, `selectedProjectId`, and `readSelectedProject()`, or `null` when none exists.
export function resolveSidebarProjectId({ explicitProjectId, pathname, selectedProjectId } = {}) {
  const fromPath = typeof pathname === "string" ? projectIdFromPath(pathname) : null;
  for (const candidate of [explicitProjectId, fromPath, selectedProjectId, readSelectedProject()]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

// Remember an admitted selection without leaking it into another open browser tab.
export function rememberSelectedProject(projectId) {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(STORAGE_KEY, projectId); }
  catch (error) { console.warn("Could not remember selected project", error); }
}
