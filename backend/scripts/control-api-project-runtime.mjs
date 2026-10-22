// Admit the Control API's existing project without starting a second watcher or rebuilding its index.
import { realpath } from "node:fs/promises";
import { startProjectRuntime } from "../src/modules/projects/project-runtime.js";

// Reuse the application's already-open storage once; later admissions start independently owned runtimes.
export function createControlApiProjectRuntime({ projectRoot, projectId, startRuntime = startProjectRuntime }) {
  const canonicalRoot = realpath(projectRoot);
  let available = true;

  // Bind catalog membership to the existing application only when root and persisted identity both match.
  return async function start(input) {
    if (!available || input.projectRoot !== await canonicalRoot) return startRuntime(input);
    if (input.projectId !== projectId) throw new Error("Catalog and Control API project identity differ.");
    available = false;
    let closed = false;
    return Object.freeze({
      projectRoot: input.projectRoot,
      projectId,
      // Expose admission availability while the application registry owns the database and worker resources.
      status() { return { projectId, projectRoot: input.projectRoot, closed }; },
      // Retire this binding; application disposal releases the shared storage without duplicate cleanup.
      close() { closed = true; }
    });
  };
}
