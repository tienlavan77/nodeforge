// Summary: Admission and lifecycle manager for supervisors — validates tickets/paths, maps task↔supervisor, and handles recovery.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { createSupervisorRuntime, migrateLegacyState } from "./supervisor-runtime.js";

/** Creates the supervisor manager handling admission, creation, and recovery of supervisors. */
export function createSupervisorManager({ eventBus, stateStore, idFactory = () => `SUP-${randomUUID()}`, onCreate = () => {}, admissionGuard = defaultAdmissionGuard, ticketValidator, dependencyChecker, pathPolicy, preparation = {} } = {}) {
  if (typeof eventBus?.subscribe !== "function") throw new ConfigurationError("Supervisor manager requires an event bus.");
  const byTask = new Map(); const bySupervisor = new Map();
  return Object.freeze({ admitTask, startTask, recover, getByTask, getBySupervisor, stopTask });
  function admitTask({ task_id: taskId, supervisor_id: requestedId, ticket, ...context } = {}) {
    if (!taskId) throw new ConfigurationError("task.started requires task_id.");
    if (typeof ticketValidator === "function") { const valid = ticketValidator(ticket ?? { id: taskId, ...context }); if (valid === false || valid?.valid === false) throw new ConfigurationError("Task ticket failed admission validation."); }
    admissionGuard({ task_id: taskId, ticket, ...context });
    if (typeof dependencyChecker === "function") {
      const result = dependencyChecker(taskId, ticket?.dependencies ?? context.dependencies ?? []);
      if (result && result.ready === false) {
        const error = new ConfigurationError(`Task dependencies are not ready: ${(result.blocked_by ?? []).map((item) => item.id ?? item).join(", ")}.`);
        error.code = "TASK_DEPENDENCIES_BLOCKED";
        error.details = result;
        throw error;
      }
    }
    if (typeof pathPolicy === "function") {
      const result = pathPolicy(ticket ?? { id: taskId, ...context });
      if (result === false || result?.allowed === false) {
        const error = new ConfigurationError("Task paths violate policy.");
        error.code = "TASK_PATH_POLICY_DENIED";
        error.details = result;
        throw error;
      }
    }
    return { task_id: taskId, supervisor_id: requestedId ?? null, context: { ticket, ...context } };
  }
  async function startTask({ task_id: taskId, supervisor_id: requestedId, ticket, restart = false, ...context } = {}) {
    admitTask({ task_id: taskId, supervisor_id: requestedId, ticket, ...context });
    const local = byTask.get(taskId);
    const supervisorId = requestedId ?? idFactory();
    const claim = await stateStore?.claimTask?.(taskId, { supervisor_id: supervisorId, state: local?.getState?.() ?? "CREATED", pending_request: { ticket, ...context } });
    if (claim && !claim.created) {
      const terminal = ["COMPLETED", "FAILED", "NEEDS_HUMAN_REVIEW"].includes(claim.state);
      const shouldRestart = restart || terminal;
      const rerunAttempt = terminal && shouldRestart ? Math.max(Number(context.attempt) || 1, (Number(claim.pending_request?.attempt) || 0) + 1) : (Number(context.attempt) || 1);
      const resetContext = { ticket, ...context, attempt: rerunAttempt };
      const existing = byTask.get(taskId);
      if (existing) { if (shouldRestart && existing.reset) await existing.reset(resetContext); return existing; }
      const runtime = createSupervisorRuntime({ taskId, supervisorId: claim.supervisor_id, eventBus, stateStore, preparation, initialState: migrateLegacyState(claim.state) ?? "CREATED", ownershipCreated: false });
      byTask.set(taskId, runtime); bySupervisor.set(claim.supervisor_id, runtime); if (shouldRestart && runtime.reset) await runtime.reset(resetContext); onCreate(runtime); return runtime;
    }
    if (!claim && local) {
      const shouldRestart = restart || ["COMPLETED", "FAILED", "NEEDS_HUMAN_REVIEW"].includes(local.getState?.());
      if (shouldRestart && local.reset) await local.reset({ ticket, ...context, attempt: Math.max(Number(context.attempt) || 1, 2) });
      return local;
    }
    const runtime = createSupervisorRuntime({ taskId, supervisorId, eventBus, stateStore, preparation, ownershipCreated: true });
    byTask.set(taskId, runtime); bySupervisor.set(supervisorId, runtime);
    await stateStore?.save?.({ task_id: taskId, supervisor_id: supervisorId, state: runtime.getState(), pending_request: { task_id: taskId, ticket_id: ticket?.id ?? taskId, project_id: context.project_id ?? ticket?.project_id, request_id: context.request_id, correlation_id: context.correlation_id, attempt: context.attempt ?? 1 }, updated_at: new Date().toISOString() });
    onCreate(runtime);
    return runtime;
  }
  async function recover() {
    const states = await stateStore?.list?.({ scope: "pending" }) ?? [];
    for (const state of states) if (state.task_id && state.supervisor_id && !byTask.has(state.task_id)) { const runtime = createSupervisorRuntime({ taskId: state.task_id, supervisorId: state.supervisor_id, eventBus, stateStore, preparation, initialState: migrateLegacyState(state.state) }); byTask.set(state.task_id, runtime); bySupervisor.set(state.supervisor_id, runtime); onCreate(runtime); }
    return states.length;
  }
  function getByTask(taskId) { return byTask.get(taskId) ?? null; }
  function getBySupervisor(supervisorId) { return bySupervisor.get(supervisorId) ?? null; }
  function stopTask(taskId) {
    const runtime = byTask.get(taskId); if (!runtime) return false;
    byTask.delete(taskId); bySupervisor.delete(runtime.supervisorId); return true;
  }
}

function defaultAdmissionGuard({ task_id: taskId, dependencies = [], paths = [] } = {}) {
  if (typeof taskId !== "string" || !taskId.trim()) throw new ConfigurationError("Task admission requires task_id.");
  if (!Array.isArray(dependencies)) throw new ConfigurationError("Task dependencies must be an array.");
  if (!Array.isArray(paths)) throw new ConfigurationError("Task paths must be an array.");
  for (const path of paths) if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("..")) throw new ConfigurationError(`Task path is outside policy: ${path ?? "<missing>"}.`);
  return true;
}
