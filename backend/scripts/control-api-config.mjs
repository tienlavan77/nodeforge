import { join } from "node:path";

export function readControlApiConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const runtimeRoot = join(cwd, ".forge", "runtime");
  const dataDir = env.NODE_CONTROL_DATA_DIR ?? join(runtimeRoot, "nf");
  return Object.freeze({
    cwd,
    port: Number(env.NODE_CONTROL_PORT ?? 3100),
    host: env.NODE_CONTROL_HOST ?? "127.0.0.1",
    runtimeRoot,
    dataDir,
    projectId: env.NODE_CONTROL_PROJECT_ID ?? "PROJECT-NODEFORGE",
    protocolStorageRoot: env.FORGE_PROTOCOL_STORAGE_ROOT ?? ".forge/runtime/protocol-storage",
    agentTimeoutMs: Number(env.NODE_AGENT_TIMEOUT_MS ?? 120000)
  });
}
