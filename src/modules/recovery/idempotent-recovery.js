import { ConfigurationError } from "../../shared/errors.js";

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED"]);

export function createIdempotentRecovery() {
  return Object.freeze({ shouldExecute, shouldComplete });

  function shouldExecute({ session, stepId, state } = {}) {
    const task = taskForSession(session, state);
    if (typeof stepId !== "string" || stepId.length === 0) throw new ConfigurationError("Idempotent Recovery requires a stepId.");
    if (TERMINAL_STATES.has(session.state) || TERMINAL_STATES.has(task.status)) return false;
    return !(task.completed_step_ids ?? []).includes(stepId);
  }

  function shouldComplete({ session, state } = {}) {
    const task = taskForSession(session, state);
    return !TERMINAL_STATES.has(session.state) && !TERMINAL_STATES.has(task.status);
  }
}

function taskForSession(session, state) {
  if (!session || typeof session.id !== "string" || typeof session.state !== "string") {
    throw new ConfigurationError("Idempotent Recovery requires a recovered session.");
  }
  if (!state?.sessions || !state?.tasks) throw new ConfigurationError("Idempotent Recovery requires replayed state.");
  const replayed = state.sessions[session.id];
  const task = state.tasks[replayed?.task_id];
  if (!task) throw new ConfigurationError("Recovered session has no replayed task state.");
  return task;
}
