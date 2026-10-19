// Coordinates application and indexing runtime cleanup without leaving failed projects available to requests.

// Shares runtime disposal outcomes while preserving cleanup of the runtime after application failures.
export function createProjectRuntimeDisposal() {
  const cleanups = new WeakMap();
  const releases = new WeakMap();
  return Object.freeze({ registerCleanup, releaseRuntime, isAvailable });

  // Accepts application cleanup only while its runtime can still serve project requests.
  function registerCleanup(runtime, cleanup) {
    if (!isAvailable(runtime)) return false;
    cleanups.set(runtime, cleanup);
    return true;
  }

  // Removes a runtime from request selection immediately when its first disposal begins.
  function isAvailable(runtime) { return !releases.has(runtime); }

  // Attempts application cleanup before runtime cleanup, aggregating errors and never retrying disposal.
  function releaseRuntime(runtime) {
    if (!releases.has(runtime)) {
      const release = Promise.resolve().then(async () => {
        const errors = [];
        for (const cleanup of [() => cleanups.get(runtime)?.(), () => runtime.close()]) {
          try { await cleanup(); } catch (error) { errors.push(error); }
        }
        cleanups.delete(runtime);
        if (errors.length) throw new AggregateError(errors, "Project runtime disposal failed.");
      });
      releases.set(runtime, release);
    }
    return releases.get(runtime);
  }
}
