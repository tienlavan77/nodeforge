import { ConfigurationError } from "../../shared/errors.js";

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED"]);

export function createWorkflowResume() {
  return Object.freeze({ resume });

  function resume({ session, state } = {}) {
    if (!session || typeof session.id !== "string" || typeof session.state !== "string") {
      throw new ConfigurationError("Workflow Resume requires a recovered session.");
    }
    if (!state?.tasks || !state.sessions) throw new ConfigurationError("Workflow Resume requires replayed state.");
    if (TERMINAL_STATES.has(session.state)) return noNextStep(session.id);
    const replayedSession = state.sessions[session.id];
    const task = state.tasks[replayedSession?.task_id];
    if (!task || task.status === "completed" || task.status === "failed") return noNextStep(session.id);
    const completedStepIds = task.completed_step_ids ?? [];
    const nextStep = (task.step_ids ?? []).find((stepId) => !completedStepIds.includes(stepId)) ?? null;
    return Object.freeze({ sessionId: session.id, nextStep, completedSteps: completedStepIds.length });
  }
}

function noNextStep(sessionId) {
  return Object.freeze({ sessionId, nextStep: null, completedSteps: 0 });
}
