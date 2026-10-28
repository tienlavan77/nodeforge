// Keeps catalog membership visible independently from live workspace admission. Attempt tokens
// prevent older startup results from overwriting a newer retry, and public diagnostics expose
// only stable error codes and safe recovery guidance rather than internal runtime exceptions.

// Tracks current-process startup attempts while deriving admission from the actual runtime map.
export function createProjectDirectoryState({ catalog, runtimes, isAvailable, isClosed }) {
  const attempts = new Map();
  return { run, directory };

  // Fences asynchronous startup results so a retry replaces its own diagnostic and readiness.
  async function run(root, start) {
    const previous = attempts.get(root);
    const attempt = { attempt_id: (previous?.attempt_id ?? 0) + 1, status: "running", diagnostic: null };
    attempts.set(root, attempt);
    try {
      const result = await start();
      if (attempts.get(root) === attempt) attempt.status = "succeeded";
      return result;
    } catch (error) {
      if (attempts.get(root) === attempt) {
        attempt.status = "failed";
        attempt.diagnostic = { code: "project_startup_failed", message: "Project startup failed. Correct the project configuration and retry Add." };
      }
      throw error;
    }
  }

  // Returns detached membership snapshots without granting workspace access from persisted metadata.
  function directory() {
    return catalog.list().map((entry) => {
      const runtime = runtimes.get(entry.root);
      const ready = !isClosed() && isAvailable(runtime);
      const operation = attempts.get(entry.root) ?? { attempt_id: 0, status: "unavailable", diagnostic: null };
      const running = !isClosed() && !ready && (operation.status === "running" || (Boolean(runtime) && runtime.status?.().closed !== true && runtime.status?.().progress?.status === "running"));
      const diagnostic = operation.diagnostic ? { ...operation.diagnostic } : null;
      return { ...entry, readiness: ready ? "ready" : running ? "running" : "unavailable", operation: { ...operation, diagnostic },
        diagnostic: diagnostic && { ...diagnostic }, retryable: !ready && !running && !runtime && operation.status !== "running" && !isClosed() };
    });
  }

  // Retrieves the active or running runtime for progress inspection without bypassing workspace readiness gates.
  function getRuntime(root) {
    if (isClosed()) return undefined;
    return runtimes.get(root);
  }

  // Resolves the project SSE stream when a project is in either `running` or `ready` state while rejecting `unavailable` projects.
  function getStream(projectId) {
    if (isClosed() || typeof projectId !== "string" || !projectId.trim()) return undefined;
    const entry = catalog.list().find((candidate) => candidate.projectId === projectId);
    const runtime = entry ? runtimes.get(entry.root) : [...runtimes.values()].find((candidate) => candidate?.projectId === projectId);
    if (!runtime || typeof runtime.connect !== "function") return undefined;
    const operation = entry ? attempts.get(entry.root) : undefined;
    const isRunningOrReady = () => {
      const current = entry ? runtimes.get(entry.root) : runtime;
      if (isClosed() || !current || typeof current.connect !== "function") return false;
      if (isAvailable(current)) return true;
      const status = current.status?.();
      if (status?.closed === true || status?.progress?.status === "failed") return false;
      const currentOp = entry ? attempts.get(entry.root) : operation;
      return currentOp?.status === "running" || status?.progress?.status === "running";
    };
    if (!isRunningOrReady()) return undefined;
    return Object.freeze({
      // Connects SSE subscribers while the project remains in `running` or `ready` state.
      connect(input) {
        const current = entry ? runtimes.get(entry.root) : runtime;
        if (!isRunningOrReady()) {
          throw Object.assign(new Error("Project is unavailable."), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
        }
        return current.connect(input);
      }
    });
  }
}
