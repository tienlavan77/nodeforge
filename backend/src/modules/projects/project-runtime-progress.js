// Adapts legacy injected runtime factories to committed index progress. A runtime factory
// historically promised startup without reporting indexing outcomes. When no index checkpoint
// was published, this adapter runs actual reconciliation before settling the operation, so
// compatibility does not require inventing counters or bypassing unresolved required work.
import { loadConfig } from "../../bootstrap/config.js";
import { rebuildIndex } from "../index/index-rebuild.js";

// Starts the supplied runtime and fills its missing progress contract with a real index pass.
// Fully integrated runtimes retain their own checkpoint. Any fallback failure closes the newly
// started runtime and preserves the original error, including cleanup errors when necessary.
export async function startRuntimeWithProgress(startRuntime, options) {
  const runtime = await startRuntime(options);
  const progress = options.progress;
  if (!progress || progress.snapshot().checkpoint) return runtime;
  try {
    const config = loadConfig({ cwd: options.projectRoot });
    const result = await rebuildIndex({ projectRoot: options.projectRoot, ignore: config.watcherIgnore, progress });
    if (!result.succeeded) throw Object.assign(new Error("Required indexing work failed."), { code: "index_failed" });
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
