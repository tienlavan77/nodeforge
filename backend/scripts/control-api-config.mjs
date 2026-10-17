import { isAbsolute, join, resolve, sep } from "node:path";

// Validates the optional external global project catalog path outside per-project .forge directories.
function resolveProjectCatalogPath(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const trimmed = String(raw).trim();
  if (!isAbsolute(trimmed) || resolve(trimmed) !== trimmed) {
    throw new Error("NODEFORGE_PROJECT_CATALOG_PATH must be a normalized absolute path.");
  }
  if (trimmed.split(sep).includes(".forge")) {
    throw new Error("NODEFORGE_PROJECT_CATALOG_PATH must be outside any project .forge directory.");
  }
  return trimmed;
}

export function readControlApiConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const runtimeRoot = join(cwd, ".forge", "runtime");
  const dataDir = env.NODE_CONTROL_DATA_DIR ?? join(runtimeRoot, "nf");
  const projectCatalogPath = resolveProjectCatalogPath(env.NODEFORGE_PROJECT_CATALOG_PATH);
  return Object.freeze({
    projectCatalogPath,
    catalogPath: projectCatalogPath,
    cwd,
    port: Number(env.NODE_CONTROL_PORT ?? 3100),
    host: env.NODE_CONTROL_HOST ?? "127.0.0.1",
    runtimeRoot,
    dataDir,
    projectId: env.NODE_CONTROL_PROJECT_ID ?? "PROJECT-NODEFORGE",
    protocolStorageRoot: env.FORGE_PROTOCOL_STORAGE_ROOT ?? ".forge/runtime/protocol-storage",
    agentTimeoutMs: Number(env.NODE_AGENT_TIMEOUT_MS ?? 3600000),
    sdkTimeoutMs: Number(env.NODE_SDK_AGENT_TIMEOUT_MS ?? 3600000)
  });
}
