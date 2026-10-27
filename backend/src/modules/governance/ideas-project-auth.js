/**
 * Enforces fail-closed caller identity and per-project permission verification for Ideas notebook operations before any project content is read or mutated.
 * This adapter pairs the server's plan-owner identity verifier with an explicit composition-supplied project permission port, refusing unconfigured permission ports with 503 IDEAS_PERMISSION_UNCONFIGURED, missing or invalid caller identities with 403, and unauthorized target projects with a non-disclosing 404 refusal so project admission, catalog membership, or UI selection never imply access.
 */
import { ConfigurationError } from "../../shared/errors.js";

/**
 * Builds an HTTP-shaped ConfigurationError with an explicit status code and machine-readable code for downstream transport formatting without leaking sensitive state.
 */
function createAuthorizationError(message, statusCode, code) {
  return Object.assign(new ConfigurationError(message), { statusCode, status: statusCode, code });
}

/**
 * Creates a frozen composition-injected Ideas project authorization adapter that validates caller identity via planOwnerAuth and evaluates per-project permission via a non-persisted callback port before allowing Idea collection or item operations.
 */
export function createIdeasProjectAuth({ planOwnerAuth, verifyIdentity, canAccessProject } = {}) {
  const resolveIdentity = typeof verifyIdentity === "function"
    ? verifyIdentity
    : (typeof planOwnerAuth?.verify === "function" ? (headers) => planOwnerAuth.verify(headers) : null);
  const evaluatePermission = typeof canAccessProject === "function"
    ? canAccessProject
    : (typeof canAccessProject?.canAccessProject === "function"
      ? (input) => canAccessProject.canAccessProject(input)
      : (typeof canAccessProject?.authorize === "function" ? (input) => canAccessProject.authorize(input) : null));

  /**
   * Verifies that the permission port is configured, authenticates caller identity from HTTP headers, and enforces explicit permission on the resolved projectId before any Idea content read or mutation proceeds.
   */
  async function authorize({ headers = {}, projectId } = {}) {
    if (typeof evaluatePermission !== "function") {
      throw createAuthorizationError("Ideas project permission port is not configured.", 503, "IDEAS_PERMISSION_UNCONFIGURED");
    }
    if (typeof resolveIdentity !== "function") {
      throw createAuthorizationError("Ideas caller identity is required.", 403, "PLAN_OWNER_UNAUTHORIZED");
    }
    let identity;
    try {
      identity = await resolveIdentity(headers);
    } catch (error) {
      if (error?.statusCode === 503 || error?.code === "PLAN_OWNER_AUTH_UNCONFIGURED") {
        throw createAuthorizationError("Ideas caller identity is required.", 403, "PLAN_OWNER_UNAUTHORIZED");
      }
      if (error?.statusCode === 403) {
        throw error;
      }
      throw createAuthorizationError("Ideas caller identity is invalid.", 403, "PLAN_OWNER_UNAUTHORIZED");
    }
    if (typeof identity !== "string" || !identity.trim()) {
      throw createAuthorizationError("Ideas caller identity is required.", 403, "PLAN_OWNER_UNAUTHORIZED");
    }
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw createAuthorizationError("Idea was not found.", 404, "IDEA_NOT_FOUND");
    }
    let permitted;
    try {
      permitted = await evaluatePermission({ identity, projectId });
    } catch (error) {
      if (error?.statusCode === 503 || error?.code === "IDEAS_PERMISSION_UNCONFIGURED") {
        throw createAuthorizationError("Ideas project permission port is not configured.", 503, "IDEAS_PERMISSION_UNCONFIGURED");
      }
      throw createAuthorizationError("Ideas project permission port is not configured.", 503, "IDEAS_PERMISSION_UNCONFIGURED");
    }
    if (typeof permitted !== "boolean") {
      throw createAuthorizationError("Ideas project permission port is not configured.", 503, "IDEAS_PERMISSION_UNCONFIGURED");
    }
    if (permitted !== true) {
      throw createAuthorizationError("Idea was not found.", 404, "IDEA_NOT_FOUND");
    }
    return Object.freeze({ identity, projectId });
  }

  return Object.freeze({ authorize });
}
