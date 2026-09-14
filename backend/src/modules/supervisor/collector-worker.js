import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

// Change-set Collector: after a session completes, inspect the working tree to
// discover what the agent actually changed. The filesystem is the source of
// truth — no patch inspection here. Output feeds the Verifier.
export function createCollectorWorker({ fileService, gitService } = {}) {
  if (typeof gitService?.status !== "function") throw new ConfigurationError("Collector Worker requires a Git Service.");
  if (typeof fileService?.readFile !== "function") throw new ConfigurationError("Collector Worker requires File Service.");
  return Object.freeze({ collect });
  async function collect(input = {}) {
    const statusOutput = await gitService.status();
    const changedPaths = parsePorcelain(statusOutput);
    const checksums = {};
    for (const path of changedPaths) {
      checksums[path] = await checksumFor(path);
    }
    return {
      task_id: input.task_id,
      supervisor_id: input.supervisor_id,
      request_id: input.request_id,
      correlation_id: input.correlation_id,
      attempt: input.attempt,
      changed_paths: changedPaths,
      checksums,
      empty: changedPaths.length === 0
    };
  }
  async function checksumFor(path) {
    try {
      const content = await fileService.readFile({ path });
      return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
}

function parsePorcelain(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^..\s/, "").trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}
