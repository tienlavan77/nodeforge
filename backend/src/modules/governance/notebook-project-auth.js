/**
 * Enforces fail-closed caller identity and per-project permission verification for Notebook operations before any project content is read or mutated.
 * Composition injects caller verification and a runtime permission callback; missing ports, unverified callers, or denied project access refuse without mutating or reading notebook data.
 */
import { ConfigurationError } from "../../shared/errors.js";

/**
 * Creates a standardized HTTP configuration error with statusCode and machine-readable code for fail-closed authorization rejections.
 */
function createAuthorizationError(message, statusCode, code) {
  return Object.assign(new ConfigurationError(message), { statusCode, status: statusCode, code });
}

/**
 * Creates a frozen composition-injected Notebook project authorization adapter that validates caller identity via planOwnerAuth and evaluates per-project permission via a non-persisted callback port before allowing Notebook collection or item operations.
 */
export function createNotebookProjectAuth({ planOwnerAuth, verifyIdentity, canAccessProject } = {}) {
  const resolveIdentity = typeof verifyIdentity === "function"
    ? verifyIdentity
    : (typeof planOwnerAuth?.verify === "function" ? (headers) => planOwnerAuth.verify(headers) : null);
  const evaluatePermission = typeof canAccessProject === "function"
    ? canAccessProject
    : (typeof canAccessProject?.canAccessProject === "function"
      ? (input) => canAccessProject.canAccessProject(input)
      : (typeof canAccessProject?.authorize === "function" ? (input) => canAccessProject.authorize(input) : null));

  /**
   * Verifies that the permission port is configured, authenticates caller identity from HTTP headers, and enforces explicit permission on the resolved projectId before any Notebook content read or mutation proceeds.
   */
  async function authorize({ headers = {}, projectId } = {}) {
    if (typeof evaluatePermission !== "function") {
      throw createAuthorizationError("Notebook project permission port is not configured.", 503, "NOTEBOOK_PERMISSION_UNCONFIGURED");
    }
    if (typeof resolveIdentity !== "function") {
      throw createAuthorizationError("Notebook caller identity is required.", 403, "PLAN_OWNER_UNAUTHORIZED");
    }
    let identity;
    try {
      identity = await resolveIdentity(headers);
    } catch (error) {
      if (error?.statusCode === 503 || error?.code === "PLAN_OWNER_AUTH_UNCONFIGURED") {
        throw createAuthorizationError("Notebook caller identity is required.", 403, "PLAN_OWNER_UNAUTHORIZED");
      }
      if (error?.statusCode === 403) {
        throw error;
      }
      throw createAuthorizationError("Notebook caller identity is invalid.", 403, "PLAN_OWNER_UNAUTHORIZED");
    }
    if (typeof identity !== "string" || !identity.trim()) {
      throw createAuthorizationError("Notebook caller identity is required.", 403, "PLAN_OWNER_UNAUTHORIZED");
    }
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw createAuthorizationError("Notebook entry was not found.", 404, "NOTEBOOK_NOT_FOUND");
    }
    let permitted;
    try {
      permitted = await evaluatePermission({ identity, projectId });
    } catch (error) {
      if (error?.statusCode === 503 || error?.code === "NOTEBOOK_PERMISSION_UNCONFIGURED") {
        throw createAuthorizationError("Notebook project permission port is not configured.", 503, "NOTEBOOK_PERMISSION_UNCONFIGURED");
      }
      throw createAuthorizationError("Notebook project permission port is not configured.", 503, "NOTEBOOK_PERMISSION_UNCONFIGURED");
    }
    if (typeof permitted !== "boolean") {
      throw createAuthorizationError("Notebook project permission port is not configured.", 503, "NOTEBOOK_PERMISSION_UNCONFIGURED");
    }
    if (permitted !== true) {
      throw createAuthorizationError("Notebook entry was not found.", 404, "NOTEBOOK_NOT_FOUND");
    }
    return Object.freeze({ identity, projectId });
  }

  return Object.freeze({ authorize });
}
