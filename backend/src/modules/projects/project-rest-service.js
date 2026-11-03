// Implements automatic project intake and configuration management over the existing lifecycle.
// Admission and updates share the lifecycle queue, preserve identity, and use O1's validated
// atomic configuration persistence. Removal delegates to resource disposal without deleting files.
import { buildProjectConfiguration, normalizeNameToSlug } from "./project-registry.js";
import { preflightProject } from "./project-rest-preflight.js";

// Binds REST operations to the catalog and existing serialized lifecycle safety boundaries.
export function createProjectRestService({ registry, catalog, directory, get, getRuntime, enqueue, admit, create, remove }) {
  return Object.freeze({ preflight: preflightProject, intake, list, update, remove: removeById });

  // Selects admission from actual host filesystem state, validating settings before membership changes.
  async function intake(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Project configuration must be an object.");
    const config = { ...input, comment_language: input.comment_language ?? "en" };
    delete config.root;
    const state = await preflightProject(input.root);
    if (state.status === "invalid") throw Object.assign(new Error(state.message), state, { statusCode: 400 });
    buildProjectConfiguration({ ...config, project_id: "rest-validation", root: state.root });
    // Exclusive Create is used only for absent targets; empty existing roots use guarded admission.
    const { lstat } = await import("node:fs/promises");
    let exists = true;
    try { await lstat(state.root); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      exists = false;
    }
    const entry = exists
      ? await enqueue(() => admit(state.root, undefined, undefined, config))
      : await create(state.root, { config });
    const configuration = await registry.readConfiguration(entry.root);
    const dirEntry = typeof directory === "function"
      ? directory().find((item) => item.projectId === entry.projectId || item.root === entry.root)
      : undefined;
    const runtime = (typeof getRuntime === "function" ? getRuntime(entry.root) : undefined) ?? (typeof get === "function" ? await get(entry.root) : undefined);
    return {
      ...configuration,
      ...(dirEntry ?? entry),
      project_id: configuration?.project_id ?? entry.projectId,
      projectId: entry.projectId,
      progress: runtime?.status?.().progress ?? null
    };
  }

  // Includes retained catalog entries, their full configuration and live indexing progress.
  async function list() {
    return Promise.all(directory().map(async (entry) => {
      let configuration = {};
      try {
        configuration = await registry.readConfiguration(entry.root);
        const runtime = (typeof getRuntime === "function" ? getRuntime(entry.root) : undefined) ?? await get(entry.root);
        return { ...configuration, ...entry, project_id: configuration?.project_id ?? entry.projectId, projectId: entry.projectId, progress: runtime?.status?.().progress ?? null };
      } catch (error) {
        return { ...configuration, ...entry, project_id: entry.projectId, projectId: entry.projectId, readiness: "unavailable", progress: null,
          diagnostic: { code: error.code ?? "project_unavailable",
            message: "Project configuration or runtime is unavailable. Restore access to the registered root and retry.",
            ...(error.stage ? { stage: error.stage } : {}), ...(error.guidance ? { guidance: error.guidance } : {}) } };
      }
    }));
  }

  // Resolves membership by stable identity or normalized slug alias so REST callers cannot update arbitrary host roots.
  function find(projectId) {
    const entries = catalog.list();
    const direct = entries.find((candidate) => candidate.projectId === projectId);
    if (direct) return direct;
    const targetSlug = normalizeNameToSlug(projectId);
    const bySlug = targetSlug
      ? entries.find((candidate) => normalizeNameToSlug(candidate.root?.split("/").filter(Boolean).at(-1) ?? "") === targetSlug)
      : undefined;
    if (!bySlug) throw Object.assign(new Error("Project is not registered."), { code: "project_not_found", statusCode: 404 });
    return bySlug;
  }

  // Persists validated settings atomically while preserving the root and project identity.
  function update(projectId, updates) {
    return enqueue(() => registry.writeConfiguration(find(projectId).root, updates));
  }

  // Releases all project resources before removing only global catalog membership.
  async function removeById(projectId) {
    const entry = find(projectId);
    return { project_id: projectId, removed: await remove(entry.root) };
  }
}

// Reports malformed REST settings as client errors before any project mutation starts.
function invalid(message) {
  return Object.assign(new Error(message), { code: "invalid_project_configuration", statusCode: 400 });
}
