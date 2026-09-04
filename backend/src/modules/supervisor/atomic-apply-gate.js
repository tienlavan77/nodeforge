import { ConfigurationError } from "../../shared/errors.js";

export function createAtomicApplyGate({ fileService, gitService } = {}) {
  if (typeof fileService?.atomicWrite !== "function" || typeof fileService?.atomicCreate !== "function") throw new ConfigurationError("Atomic apply gate requires File Service atomic writes.");
  return Object.freeze({ apply });
  async function apply({ patches = [], commitMessage = "Apply verified changes" } = {}) {
    if (!patches.length || patches.some((patch) => patch.verification?.passed !== true)) throw new ConfigurationError("Atomic apply requires all patches to pass verification.");
    const paths = [];
    for (const patch of patches) {
      if (patch.exists === false) await fileService.atomicCreate({ path: patch.path, content: patch.content });
      else await fileService.atomicWrite({ path: patch.path, content: patch.content, replace: true });
      paths.push(patch.path);
    }
    const commit = await gitService?.commit?.(commitMessage, { paths });
    return { paths, commit };
  }
}
