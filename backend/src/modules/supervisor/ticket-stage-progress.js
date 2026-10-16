// Records SL/AM/Owner/Reviewer stage positions inside the single ticket checkpoint so every stop is resumable.

const STAGE_FAIL = { code: "STAGE_PROGRESS_WRITE_FAILED" };

// Appends or updates one stage entry in the ticket checkpoint; checkpoint faults never fail recovery itself.
export async function recordTicketStage({ checkpoints, taskId, stage, status, details = {}, logger = console, clock = Date.now }) {
  if (!checkpoints?.load || !checkpoints?.save || !taskId || !stage) return null;
  try {
    const checkpoint = await checkpoints.load(taskId);
    if (!checkpoint) return null;
    const progress = Array.isArray(checkpoint.stage_progress) ? checkpoint.stage_progress : [];
    const last = progress.at(-1);
    const entry = { stage, status, at: new Date(clock()).toISOString(), ...details };
    const next = last && last.stage === stage && (last.job_id ?? null) === (details.job_id ?? null)
      ? [...progress.slice(0, -1), { ...last, ...details, status, at: entry.at }]
      : [...progress, entry];
    return await checkpoints.save({ ...checkpoint, stage_progress: next });
  } catch (error) {
    logger.warn?.("Ticket stage checkpoint write failed; recovery continues from the ledger.", { task_id: taskId, stage, code: error?.code ?? STAGE_FAIL.code, error: error?.message ?? String(error) });
    return null;
  }
}

// Mirrors Reviewer progress into the ticket checkpoint only while the Coder half is terminal, so concurrent Coder writes cannot be clobbered.
export async function recordTicketReviewStage({ checkpoints, taskId, status, details = {}, logger = console, clock = Date.now }) {
  if (!checkpoints?.load || !checkpoints?.save || !taskId) return null;
  try {
    const checkpoint = await checkpoints.load(taskId);
    if (!checkpoint || checkpoint.status !== "completed") return null;
    return await checkpoints.save({ ...checkpoint, review_stage: { status, at: new Date(clock()).toISOString(), ...details } });
  } catch (error) {
    logger.warn?.("Ticket review stage checkpoint write failed; review recovery continues from its own checkpoint.", { task_id: taskId, code: error?.code ?? STAGE_FAIL.code, error: error?.message ?? String(error) });
    return null;
  }
}
