// Exposes the running project in the directory when optional multi-project admission is not configured.

// Preserve the lifecycle contract while allowing owners to open the actual single-project runtime.
export function createProjectDirectoryLifecycle({ projectLifecycle, projectId, projectRoot }) {
  if (projectLifecycle) return projectLifecycle;
  if (!projectId || !projectRoot) return undefined;
  return Object.freeze({
    list: () => [{ projectId, root: projectRoot }],
    // Reports the active single-project process without inferring readiness from catalog membership.
    directory: () => [{ projectId, root: projectRoot, readiness: "ready", operation: { attempt_id: 1, status: "succeeded", diagnostic: null }, diagnostic: null, retryable: false }],
    startupErrors: [],
    add: unavailable,
    remove: unavailable
  });
}

// Refuse mutations until the real project catalog and runtime lifecycle are configured.
function unavailable() {
  throw Object.assign(new Error("Adding and removing projects requires configuring the project catalog on the Control API."), {
    code: "lifecycle_unavailable", statusCode: 503, retryable: false, scope: "scoped"
  });
}
