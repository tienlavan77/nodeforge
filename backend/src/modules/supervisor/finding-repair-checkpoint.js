// Resolves finding preparation at the shared Coder entry point so direct RUN and queued dependency work use the same journal.
// Completed finding commands remain archived evidence after a new integrated repair cycle replaces their source.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";

// Retires only a finding key proven to belong to the archived source of the current Node-owned repair cycle.
// Other finding resumes still execute the existing source validation rather than silently skipping preparation.
export async function prepareFindingRepairCheckpoint({ taskId, projectId, payload, workspace, fileService, checkpoints }) {
  const coder = payload.resume_from;
  const key = coder?.review_repair_key;
  if (payload.review_resume || !key || !workspace?.beginFindingRepair) return payload;
  const context = await workspace.executionContexts?.load?.(taskId);
  const cycle = context?.review_repair_cycle_id;
  if (cycle && coder.review_cycle_id === cycle && context.task_id === taskId && context.project_id === projectId
    && !context.source_repair_cycle_id && /^[A-Za-z0-9-]+$/.test(cycle)) {
    const scope = createHash("sha256").update(projectId).digest("hex");
    const receipt = JSON.parse(await fileService.readFile({ path: `${statePath()}/ticket-review-repairs/${scope}/${taskId}/${cycle}.json` }));
    if (receipt.phase === "ready" && receipt.cycle_id === cycle && receipt.task_id === taskId && receipt.project_id === projectId
      && receipt.context?.source_repair_cycle_id && key === `sha256:${receipt.context.source_repair_cycle_id}`) {
      const resumed = { ...coder };
      delete resumed.review_repair_key;
      delete resumed.repair_implementation_required;
      const current = await checkpoints?.load?.(taskId);
      if (current && isDeepStrictEqual(current, coder)) await checkpoints.save(resumed);
      return { ...payload, resume_from: resumed };
    }
  }
  await workspace.beginFindingRepair(key);
  return payload;
}
