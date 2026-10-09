// Builds control API URLs without duplicating project identity already carried by a project-scoped path.

// Preserves query context for unscoped endpoints and removes only project values identical to the path identity.
export function forgeV1(pathname, query = {}) {
  const params = new URLSearchParams();
  const projectSegment = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  const pathProject = projectSegment === undefined ? undefined : decodeURIComponent(projectSegment);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (key === "project" && pathProject === String(value)) continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return `${controlApiBase()}/forge/v1${pathname}${search ? `?${search}` : ""}`;
}

// Resolves the configured or browser-local control API origin without changing deployment defaults.
export function controlApiBase() {
  const configured = process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window !== "undefined" && window.location?.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:3100`;
  }
  return "http://127.0.0.1:3100";
}
