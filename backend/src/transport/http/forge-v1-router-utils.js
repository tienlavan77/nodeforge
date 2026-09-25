// Normalizes Forge API requests and reports unavailable services.
import { ConfigurationError } from "../../shared/errors.js";

// Normalizes a URL pathname into route parts.
export function normalizeParts(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "forge" && parts[1] === "v1") return parts.slice(2);
  return parts;
}

// Creates a 503 unavailable error for unconfigured services.
export function unavailable(name) {
  return Object.assign(new ConfigurationError(`${name} API is not configured.`), { statusCode: 503 });
}

// Checks whether a ticket run requests a clean restart.
export function runRequestsFresh(url, body) {
  const query = url?.searchParams?.get?.("fresh");
  if (query != null) return query === "true" || query === "1";
  return body?.fresh === true || body?.fresh === "true";
}

// Validates that a project ID is provided.
export function requireProject(projectId) {
  if (!projectId) throw Object.assign(new ConfigurationError("Project query parameter is required."), { statusCode: 400, code: "PROJECT_REQUIRED" });
}

// Reads and parses a JSON request body.
export async function readJson(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigurationError("Request body must be valid JSON.");
  }
}
