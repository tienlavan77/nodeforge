// Resolves existing request identifiers consistently before selecting project-bound services.
import { ConfigurationError } from "../../shared/errors.js";

// Rejects contradictory project identifiers without falling back to a different runtime.
export function resolveProjectRequest({ method, url, body = {}, parts = [] }) {
  const conversationProject = method === "GET" && parts.length === 1 && parts[0] === "conversations" ? url.searchParams.get("project_id") : undefined;
  const identifiers = [conversationProject, body.project_id, body.project, url.searchParams.get("project"), parts[0] === "projects" ? parts[1] : undefined]
    .filter((value) => value !== undefined && value !== null);
  if (identifiers.some((value) => value !== identifiers[0])) {
    throw Object.assign(new ConfigurationError("Project context differs between request identifiers."), { statusCode: 409, code: "PROJECT_CONTEXT_CONFLICT" });
  }
  return identifiers[0];
}

// Requires an admitted project runtime before any project-bound operation can execute.
export async function selectProjectRouter({ projectId, resolveProjectRouter }) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw Object.assign(new ConfigurationError("project is required."), { statusCode: 400, code: "PROJECT_REQUIRED" });
  }
  const selected = await resolveProjectRouter(projectId);
  if (!selected?.route) {
    throw Object.assign(new ConfigurationError("Project is unavailable."), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
  }
  return selected;
}

