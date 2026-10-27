// Exposes the five approved project management REST operations before project-scoped routing.
// Management resolves registered identities through the lifecycle and retains detailed safety
// diagnostics rather than replacing filesystem errors with generic startup messages.
import { readJson } from "./forge-v1-router-utils.js";

// Dispatches only collection, preflight and identity management routes without changing authentication.
export async function routeProjectRest(method, url, request, lifecycle) {
  const match = url.pathname.match(/^\/forge\/v1\/projects(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  const id = match[1];
  if (!(id === "preflight" && method === "POST" || !id && ["GET", "POST"].includes(method) ||
    id && id !== "preflight" && ["PUT", "DELETE"].includes(method))) return null;
  if (!lifecycle?.rest) throw Object.assign(new Error("Project lifecycle management is not configured."),
    { code: "lifecycle_unavailable", statusCode: 503 });
  const rest = lifecycle.rest;
  try {
    if (id === "preflight") return { status: 200, body: await rest.preflight((await readJson(request)).root) };
    if (!id && method === "GET") return { status: 200, body: { projects: await rest.list() } };
    if (!id) return { status: 201, body: { project: await rest.intake(await readJson(request)) } };
    if (method === "PUT") return { status: 200, body: { project: await rest.update(id, await readJson(request)) } };
    return { status: 200, body: await rest.remove(id) };
  } catch (error) {
    if (!error.statusCode) error.statusCode = error.code === "CONFIGURATION_ERROR" || error.name === "ConfigurationError" ? 400 : 500;
    if (error.stage) return { status: error.statusCode, body: { error: {
      code: error.code, message: error.message, stage: error.stage, guidance: error.guidance,
      principal: error.principal, ownership: error.ownership, path: error.path, retryable: error.retryable ?? false
    } } };
    throw error;
  }
}
