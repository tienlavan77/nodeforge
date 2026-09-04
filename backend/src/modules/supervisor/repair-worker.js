import { ConfigurationError } from "../../shared/errors.js";
export function createRepairWorker({ agent, materializer, maxAttempts = 3 } = {}) {
  if (typeof agent?.repair !== "function" || typeof materializer?.materialize !== "function") throw new ConfigurationError("Repair worker requires agent.repair and materializer.materialize.");
  return Object.freeze({ repair });
  async function repair(request) {
    if ((request.attempt ?? 1) > (request.max_attempts ?? maxAttempts)) return { status: "needs_human_review", repair_id: request.repair_id, repaired_patches: [] };
    const response = await agent.repair(request);
    const result = await materializer.materialize({ ...request, files: response.repaired_patches ?? [] });
    return { ...result, repair_id: request.repair_id, status: result.invalid_patches.length ? "failed" : "passed" };
  }
}
