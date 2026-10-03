// Keeps direct coding requests behind the approved ticket plan gate.
import { ConfigurationError } from "../../shared/errors.js";
import { requireProject, unavailable } from "./forge-v1-router-utils.js";

// Routes legacy direct-code endpoints while refusing unbound implementation work.
export async function routeDirectCode({ method, parts, body, projectId, url, directCodeRequest, sprintRegistry } = {}) {
  if (parts[0] !== "code") return null;
  if (method === "POST" && parts.length === 2 && parts[1] === "run") {
    if (sprintRegistry) throw Object.assign(new ConfigurationError("Implementation requires a ticket bound to an approved plan; use the ticket RUN route."), { code: "PLAN_APPROVAL_REQUIRED", statusCode: 409 });
    if (typeof directCodeRequest?.run !== "function") throw unavailable("Direct Code");
    requireProject(projectId);
    return { status: 200, body: await directCodeRequest.run({ projectId, sprintId: body.sprint_id, text: body.text }) };
  }
  if (method === "GET" && parts.length === 2 && parts[1] === "checkpoints") {
    if (typeof directCodeRequest?.listPending !== "function") throw unavailable("Direct Code");
    requireProject(projectId);
    return { status: 200, body: { checkpoints: await directCodeRequest.listPending({ projectId, sprintId: url.searchParams.get("sprint_id") ?? undefined }) } };
  }
  if (method === "POST" && parts.length === 3 && parts[2] === "resume") {
    if (sprintRegistry) throw Object.assign(new ConfigurationError("Direct code checkpoint cannot prove an approved ticket plan."), { code: "PLAN_APPROVAL_REQUIRED", statusCode: 409 });
    if (typeof directCodeRequest?.resume !== "function") throw unavailable("Direct Code");
    requireProject(projectId);
    return { status: 200, body: await directCodeRequest.resume({ projectId, taskId: parts[1] }) };
  }
  return null;
}
