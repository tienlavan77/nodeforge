/**
 * Routes and resolves Forge v1 Ideas HTTP requests through admitted project services and enforces project authorization before any Idea content read or mutation.
 * Collection endpoints resolve project_id strictly through the admitted-project registry without falling back to default services, while item endpoints perform metadata-only location of (id, project_id) across admitted Ideas stores, detect duplicate identifiers across projects, reject contradictory client project references, and bind every content operation to both project_id and id.
 */
import { ConfigurationError } from "../../shared/errors.js";
import { createIdeasStore } from "../../modules/projects/ideas-store.js";

/**
 * Constructs an HTTP-compatible ConfigurationError with a consistent statusCode and error code so Ideas resolution failures never leak foreign project existence or content.
 */
function ideaHttpError(message, statusCode, code) {
  return Object.assign(new ConfigurationError(message), { statusCode, status: statusCode, code });
}

/**
 * Extracts and validates the Idea store for a single admitted project service bundle, ensuring the underlying project admission remains active and the control database is open before returning a store bound to that projectId.
 */
function extractAdmittedStore(services, projectId) {
  if (!services || services.projectId !== projectId) return undefined;
  services.assertAdmission?.();
  const db = services.controlDb ?? services.database;
  if (services.ideas) {
    if (typeof services.ideas.locate === "function") return services.ideas;
    if (!db?.all) return services.ideas;
    return Object.freeze({
      ...services.ideas,
      projectId,
      locate(id) {
        if (typeof id !== "string" || !id.trim()) return undefined;
        const row = db.all("SELECT id, project_id FROM ideas WHERE project_id = ? AND id = ?", [projectId, id])[0]
          ?? db.all("SELECT id, project_id FROM idea_deletions WHERE project_id = ? AND id = ?", [projectId, id])[0];
        return row ? Object.freeze({ id: row.id, project_id: row.project_id }) : undefined;
      }
    });
  }
  return db?.transaction && db?.run && db?.all ? createIdeasStore({ controlDb: db, projectId }) : undefined;
}

/**
 * Resolves the admitted service bundle and Ideas store for an explicitly referenced projectId without ever falling back to the default project's services when resolution fails.
 */
async function resolveAdmittedIdeas({ projectId, resolveProjectServices, projectLifecycle, expectedProjectId, assertAdmission, defaultServices }) {
  if (typeof projectId !== "string" || !projectId.trim()) throw ideaHttpError("project_id is required.", 400, "PROJECT_REQUIRED");
  if (typeof resolveProjectServices === "function") {
    const selected = await resolveProjectServices(projectId);
    const store = extractAdmittedStore(selected, projectId);
    if (!store) throw ideaHttpError("Project is unavailable.", 404, "PROJECT_NOT_FOUND");
    return { projectId, services: selected, store };
  }
  if (projectLifecycle?.list) {
    const entry = projectLifecycle.list().find((item) => item.projectId === projectId);
    const runtime = entry ? await projectLifecycle.get?.(entry.root) : undefined;
    if (!runtime || runtime.projectId !== projectId || runtime.status?.().closed || ["failed", "running"].includes(runtime.status?.().progress?.status)) {
      throw ideaHttpError("Project is unavailable.", 404, "PROJECT_NOT_FOUND");
    }
    const store = extractAdmittedStore(runtime, projectId) ?? (expectedProjectId === projectId ? extractAdmittedStore(defaultServices, projectId) : undefined);
    if (!store) throw ideaHttpError("Project is unavailable.", 404, "PROJECT_NOT_FOUND");
    return { projectId, services: runtime, store };
  }
  assertAdmission?.();
  const store = expectedProjectId === projectId ? extractAdmittedStore(defaultServices, projectId) : undefined;
  if (!store) throw ideaHttpError("Project is unavailable.", 404, "PROJECT_NOT_FOUND");
  return { projectId, services: defaultServices, store };
}

/**
 * Performs metadata-only location of (id, project_id) across all currently admitted Ideas stores before authorization and content access, maintaining a derived location cache that revalidates live store admission and detects duplicate identifiers across projects.
 */
async function locateIdeaMetadata({ ideaId, locationCache, projectLifecycle, resolveProjectServices, expectedProjectId, assertAdmission, defaultServices }) {
  const admittedIds = typeof projectLifecycle?.list === "function"
    ? [...new Set(projectLifecycle.list().map((item) => item?.projectId).filter((id) => typeof id === "string" && id.trim()))]
    : (!resolveProjectServices && expectedProjectId ? [expectedProjectId] : []);
  const orderedIds = [];
  const cached = locationCache.get(ideaId);
  if (cached && admittedIds.includes(cached)) orderedIds.push(cached);
  else if (cached) locationCache.delete(ideaId);
  for (const id of admittedIds) {
    if (!orderedIds.includes(id)) orderedIds.push(id);
  }
  const matches = [];
  for (const projectId of orderedIds) {
    try {
      const candidate = await resolveAdmittedIdeas({ projectId, resolveProjectServices, projectLifecycle, expectedProjectId, assertAdmission, defaultServices });
      const metadata = typeof candidate.store.locate === "function" ? await candidate.store.locate(ideaId) : undefined;
      if (metadata && metadata.id === ideaId && metadata.project_id === projectId) {
        matches.push({ metadata, projectId, store: candidate.store });
      } else if (projectId === cached) {
        locationCache.delete(ideaId);
      }
    } catch (error) {
      if (projectId === cached) locationCache.delete(ideaId);
      if (error?.statusCode === 404 || /closed/i.test(String(error?.message ?? ""))) continue;
      throw error;
    }
  }
  if (matches.length > 1) {
    locationCache.delete(ideaId);
    throw ideaHttpError("Idea identifier conflicts across multiple projects.", 409, "IDEA_PROJECT_CONFLICT");
  }
  if (matches.length === 1) {
    locationCache.set(ideaId, matches[0].projectId);
    return matches[0];
  }
  locationCache.delete(ideaId);
  return undefined;
}

/**
 * Extracts and validates client-supplied project references on collection or item requests, rejecting conflicting query and payload project identifiers with 409 PROJECT_CONTEXT_CONFLICT.
 */
function parseProjectReference({ method, url, body = {}, isCollection }) {
  const queryProjectId = url.searchParams.get("project_id");
  const queryProject = url.searchParams.get("project");
  const bodyProjectId = body && typeof body === "object" ? body.project_id : undefined;
  const bodyProject = body && typeof body === "object" ? body.project : undefined;
  const refs = [queryProjectId, queryProject, bodyProjectId, bodyProject].filter((v) => v !== undefined && v !== null);
  if (refs.some((v) => typeof v !== "string" || !v.trim())) throw ideaHttpError("project_id is required.", 400, "PROJECT_REQUIRED");
  if (refs.some((v) => v !== refs[0])) throw ideaHttpError("Project context differs between request identifiers.", 409, "PROJECT_CONTEXT_CONFLICT");
  if (isCollection && method === "GET") {
    if (!(queryProjectId ?? queryProject)) throw ideaHttpError("project_id is required.", 400, "PROJECT_REQUIRED");
    return queryProjectId ?? queryProject;
  }
  if (isCollection && method === "POST") {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw ideaHttpError("Invalid payload.", 400, "INVALID_IDEA_PAYLOAD");
    if (Object.keys(body).some((k) => k !== "project_id" && k !== "content")) throw ideaHttpError("Unsupported field in POST /ideas.", 400, "INVALID_IDEA_PAYLOAD");
    if (typeof body.project_id !== "string" || !body.project_id.trim()) throw ideaHttpError("project_id is required.", 400, "PROJECT_REQUIRED");
    return body.project_id;
  }
  return refs[0];
}

/**
 * Executes a bound Idea item operation against the located project's store after verifying live admission and enforcing that every read, update, and delete remains bound to both project_id and id.
 */
async function runBoundItemOperation({ method, ideaId, located, body, url, context }) {
  const { store } = await resolveAdmittedIdeas({ ...context, projectId: located.projectId });
  if (method === "GET") {
    const record = await store.get(ideaId, { projectId: located.projectId });
    if (!record || record.project_id !== located.projectId || record.id !== ideaId) throw ideaHttpError("Idea not found.", 404, "IDEA_NOT_FOUND");
    return { status: 200, body: record };
  }
  if (method === "PATCH") {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw ideaHttpError("Invalid payload.", 400, "INVALID_IDEA_PAYLOAD");
    if ("project_id" in body || "project" in body) {
      const code = body.project_id !== located.projectId && body.project !== located.projectId ? "PROJECT_CONTEXT_CONFLICT" : "INVALID_IDEA_PAYLOAD";
      throw ideaHttpError("Cannot mutate or redirect Idea project_id.", code === "PROJECT_CONTEXT_CONFLICT" ? 409 : 400, code);
    }
    if (Object.keys(body).some((k) => !["content", "status", "expected_version"].includes(k)) || (body.content === undefined && body.status === undefined)) {
      throw ideaHttpError("Invalid PATCH fields.", 400, "INVALID_IDEA_PAYLOAD");
    }
    if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1) throw ideaHttpError("Invalid expected_version.", 400, "INVALID_IDEA_VERSION");
    const updated = await store.update(ideaId, {
      projectId: located.projectId,
      version: body.expected_version,
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.status !== undefined ? { status: body.status } : {})
    });
    return { status: 200, body: updated };
  }
  const versionParam = url.searchParams.get("expected_version");
  const version = body?.expected_version !== undefined ? body.expected_version : (versionParam !== null ? Number(versionParam) : undefined);
  if (!Number.isSafeInteger(version) || version < 1) throw ideaHttpError("Invalid expected_version.", 400, "INVALID_IDEA_VERSION");
  await store.delete(ideaId, { projectId: located.projectId, version });
  return { status: 200, body: { deleted: true, id: ideaId, project_id: located.projectId } };
}

/**
 * Dispatches `/forge/v1/ideas` and `/forge/v1/ideas/:ideaId` before generic project-router selection, enforcing fail-closed authorization and project-bound resolution for all five Ideas endpoints.
 */
export function createForgeV1IdeasRoutes({ ideasAuth, resolveProjectServices, projectLifecycle, expectedProjectId, assertAdmission, defaultServices } = {}) {
  const locationCache = new Map();
  const context = { resolveProjectServices, projectLifecycle, expectedProjectId, assertAdmission, defaultServices };

  /**
   * Handles incoming HTTP requests targeting the Ideas resource, returning undefined for non-Ideas paths so the main Forge v1 router continues normal processing.
   */
  async function routeIdeas({ method, parts, url, body = {}, headers = {} }) {
    if (parts[0] !== "ideas") return undefined;
    if (parts.length > 2) throw ideaHttpError("Route not found.", 404, "ROUTE_NOT_FOUND");
    if (typeof ideasAuth?.authorize !== "function") throw ideaHttpError("Ideas project permission port is not configured.", 503, "IDEAS_PERMISSION_UNCONFIGURED");
    if (parts.length === 1) {
      if (method !== "GET" && method !== "POST") throw ideaHttpError("Route not found.", 404, "ROUTE_NOT_FOUND");
      const projectId = parseProjectReference({ method, url, body, isCollection: true });
      const resolved = await resolveAdmittedIdeas({ ...context, projectId });
      await ideasAuth.authorize({ headers, projectId: resolved.projectId });
      const active = await resolveAdmittedIdeas({ ...context, projectId: resolved.projectId });
      if (method === "GET") {
        const status = url.searchParams.get("status") ?? "open";
        if (!["open", "done", "all"].includes(status)) throw ideaHttpError("Invalid Idea status filter.", 400, "INVALID_IDEA_STATUS");
        return { status: 200, body: await active.store.list({ status, projectId: active.projectId }) };
      }
      if (typeof body.content !== "string" || !body.content.trim()) throw ideaHttpError("Idea content must be a non-empty string.", 400, "INVALID_IDEA_CONTENT");
      const created = await active.store.create({ content: body.content, status: "open", projectId: active.projectId });
      if (created?.id) locationCache.set(created.id, active.projectId);
      return { status: 201, body: created };
    }
    const ideaId = parts[1];
    if (!["GET", "PATCH", "DELETE"].includes(method)) throw ideaHttpError("Route not found.", 404, "ROUTE_NOT_FOUND");
    const clientRef = parseProjectReference({ method, url, body, isCollection: false });
    if (clientRef !== undefined) await resolveAdmittedIdeas({ ...context, projectId: clientRef });
    const located = await locateIdeaMetadata({ ...context, ideaId, locationCache });
    if (!located) {
      await ideasAuth.authorize({ headers, projectId: clientRef ?? "__unlocated_idea__" });
      throw ideaHttpError("Idea not found.", 404, "IDEA_NOT_FOUND");
    }
    if (clientRef !== undefined && clientRef !== located.projectId) {
      await ideasAuth.authorize({ headers, projectId: located.projectId });
      throw ideaHttpError("Project reference conflicts with the located Idea project.", 409, "PROJECT_CONTEXT_CONFLICT");
    }
    await ideasAuth.authorize({ headers, projectId: located.projectId });
    return runBoundItemOperation({ method, ideaId, located, body, url, context });
  }

  return Object.freeze({ routeIdeas });
}
