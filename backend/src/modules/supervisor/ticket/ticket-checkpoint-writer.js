// Persists ticket resume checkpoints on a best-effort basis so a later RUN
// resumes the previous execution instead of restarting blind. Save failures
// only lose resume granularity; tool results are already computed upstream.
import { checkpointPayload } from "./ticket-resume.js";

// Saves a lightweight in-progress checkpoint without failing the run.
export function saveProgressCheckpoint(checkpoints, resumeState, fields = {}) {
  if (!checkpoints || typeof checkpoints.save !== "function") return Promise.resolve(null);
  const payload = checkpointPayload(resumeState, { status: "in_progress", ...fields });
  // eslint-disable-next-line no-silent-catch -- Best-effort resume granularity; never fail tool execution for checkpoint persistence.
  return checkpoints.save(payload).catch(() => null);
}
