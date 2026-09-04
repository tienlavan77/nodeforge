import { ConfigurationError } from "../../shared/errors.js";

export const SUPERVISOR_STATES = Object.freeze(["CREATED", "PREPARING", "READY", "REQUESTING", "WAITING_AGENT", "MATERIALIZING", "VERIFYING", "REPAIRING", "WAITING_REPAIR", "COMPLETED", "FAILED", "NEEDS_HUMAN_REVIEW"]);

export function createSupervisorRuntime({ taskId, supervisorId, eventBus, initialState = "CREATED", stateStore, preparation = {} } = {}) {
  if (!taskId || !supervisorId || typeof eventBus?.publish !== "function") throw new ConfigurationError("Supervisor runtime requires task_id, supervisor_id and event bus.");
  let state = initialState;
  return Object.freeze({ taskId, supervisorId, getState: () => state, transition, command, prepare });
  async function transition(next, context = {}) {
    if (!SUPERVISOR_STATES.includes(next)) throw new ConfigurationError(`Unknown Supervisor state: ${next}`);
    const previous = state; state = next;
    await stateStore?.save?.({ task_id: taskId, supervisor_id: supervisorId, state, pending_request: context, updated_at: new Date().toISOString() });
    await eventBus.publish({ type: "supervisor.state_changed", task_id: taskId, supervisor_id: supervisorId, request_id: context.request_id ?? `STATE-${taskId}-${next}`, correlation_id: context.correlation_id ?? `CORR-${taskId}`, attempt: context.attempt ?? 1, payload: { from: previous, to: next } });
    return state;
  }
  async function command(type, payload, context = {}) {
    return eventBus.publish({ type, task_id: taskId, supervisor_id: supervisorId, request_id: context.request_id, correlation_id: context.correlation_id, attempt: context.attempt ?? 1, payload });
  }
  async function prepare(context = {}) {
    if (["READY", "REQUESTING", "WAITING_AGENT", "MATERIALIZING", "VERIFYING", "REPAIRING", "WAITING_REPAIR", "COMPLETED"].includes(state)) return { state, reused: true };
    await transition("PREPARING", context);
    try {
      const result = {};
      if (typeof preparation.createTaskSession === "function") Object.assign(result, await preparation.createTaskSession({ task_id: taskId, supervisor_id: supervisorId, ...context }));
      if (typeof preparation.createBranch === "function") Object.assign(result, await preparation.createBranch({ task_id: taskId, branch: `task/${taskId}`, ...context }));
      if (typeof preparation.resolveCodeIndex === "function") result.code_index_revision = await preparation.resolveCodeIndex({ task_id: taskId, ...context });
      if (typeof preparation.persist === "function") await preparation.persist({ task_id: taskId, supervisor_id: supervisorId, state: "READY", preparation: result, ...context });
      await transition("READY", { ...context, preparation: result });
      return { state: "READY", preparation: result };
    } catch (error) {
      await transition("FAILED", { ...context, error: { code: error.code ?? "SUPERVISOR_PREPARATION_FAILED", message: error.message } });
      throw error;
    }
  }
}
