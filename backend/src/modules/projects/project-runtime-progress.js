// Adapts legacy injected runtime factories to committed index progress. A runtime factory
// historically promised startup without reporting indexing outcomes. When no index checkpoint
// was published, this adapter runs actual reconciliation before settling the operation, so
// compatibility does not require inventing counters or bypassing unresolved required work.
import { loadConfig } from "../../bootstrap/config.js";
import { rebuildIndex } from "../index/index-rebuild.js";
import { normalizeProjectComments } from "./project-comment-normalization.js";

// Starts the supplied runtime and fills its missing progress contract with a real index pass.
// Fully integrated runtimes retain their own checkpoint. Any fallback failure closes the newly
// started runtime and preserves the original error, including cleanup errors when necessary.
export async function startRuntimeWithProgress(startRuntime, options) {
  const runtime = await startRuntime(options);
  const progress = options.progress;
  try {
    if (!progress) return runtime;
    if (progress.snapshot().checkpoint) {
      if (progress.snapshot().status !== "succeeded") throw Object.assign(new Error("Required indexing work failed."), { code: "index_failed" });
      return runtime;
    }
    const config = loadConfig({ cwd: options.projectRoot });
    progress.stage("comment_normalization");
    if (options.normalizeComments !== false) {
      await normalizeProjectComments({
        projectRoot: options.projectRoot, projectId: options.projectId, ignore: config.watcherIgnore,
        coderNormalizer: options.coderNormalizer, rejectOnViolation: options.rejectOnViolation ?? true,
        fallbackOnViolation: options.fallbackOnViolation ?? false, force: typeof options.coderNormalizer === "function",
        internalBus: runtime?.bus, progress
      });
    }
    const result = await rebuildIndex({ projectRoot: options.projectRoot, ignore: config.watcherIgnore, progress });
    if (!result.succeeded) throw Object.assign(new Error("Required indexing work failed."), { code: "index_failed" });
    progress.stage("embedding");
    progress.stage("startup/readiness");
    progress.finish();
    return runtime;
  } catch (error) {
    progress.fail(error);
    try { await runtime?.close?.(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Runtime progress reconciliation and cleanup failed.");
    }
    throw error;
  }
}

// Resolves a project's SSE stream handle while the project is in either `running` or `ready` state while rejecting `unavailable` projects.
// Business purpose: allows `GET /forge/v1/stream?project=<projectId>` to connect and stream real-time intake, comment normalization, and indexing progress under Option B while business APIs remain gated by `readiness === "ready"`.
// Technical description: checks catalog membership and runtime progress status, returning a guarded `connect` wrapper only when the runtime is `running` or `ready`.
export const createLifecycleStreamResolver = ({ catalog, runtimes, isAvailable, isClosed }) => (projectId) => {
  if (isClosed() || typeof projectId !== "string" || !projectId.trim()) return undefined;
  const entry = catalog.list().find((item) => item.projectId === projectId);
  const findRuntime = () => entry ? runtimes.get(entry.root) : [...runtimes.values()].find((item) => item?.projectId === projectId);
  const canStream = () => {
    const current = findRuntime();
    if (isClosed() || !current || typeof current.connect !== "function") return false;
    if (isAvailable(current)) return true;
    const status = current.status?.();
    return status?.closed !== true && status?.progress?.status === "running";
  };
  if (!canStream()) return undefined;
  return Object.freeze({
    connect(input) {
      if (!canStream()) throw Object.assign(new Error("Project is unavailable."), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
      return findRuntime().connect(input);
    }
  });
};
