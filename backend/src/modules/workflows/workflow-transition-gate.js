import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ConfigurationError } from "../../shared/errors.js";
import { createWorkflowRuleEvaluator } from "../rules/workflow-rule-evaluator.js";
import { createNodeEventValidator } from "../watcher/debounced-watcher.js";
import { createStateMachineExecutor } from "./state-machine-executor.js";

const STATE_FILE = ".forge/runtime/state.json";
const OWNER_APPROVAL_SCOPES = ["scope_change", "architecture_change", "api_change", "dependency_change", "acceptance_criteria_change", "owner_accepted_risk"];

export function createWorkflowTransitionGate({ workflow, projectId, projectRoot, internalBus, executor = createStateMachineExecutor({ workflow }), ruleEvaluator = createWorkflowRuleEvaluator({ projectId, internalBus }), clock = () => new Date(), createEventId = () => `EVT-${randomUUID()}`, validateEvent = createNodeEventValidator(), stateStore } = {}) {
  if (typeof projectId !== "string" || projectId.length === 0 || typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new ConfigurationError("A project_id and project root are required for workflow transitions.");
  }
  if (typeof executor?.transition !== "function" || typeof ruleEvaluator?.execute !== "function" || typeof clock !== "function" || typeof createEventId !== "function" || typeof validateEvent !== "function" || !internalBus?.emit) {
    throw new ConfigurationError("Workflow transition dependencies are invalid.");
  }
  const store = stateStore ?? createRuntimeStateStore({ projectRoot });
  if (typeof store.readTask !== "function" || typeof store.writeTask !== "function") {
    throw new ConfigurationError("Workflow state storage must read and write task state.");
  }

  const pendingOwnerDecisions = new Map();

  return Object.freeze({ transition, respondOwner, statePath: store.path });

  async function transition({ taskId, currentState, event, trigger = "workflow.transition", context = {} } = {}) {
    if (typeof taskId !== "string" || taskId.length === 0 || typeof currentState !== "string" || currentState.length === 0 || typeof event !== "string" || event.length === 0) {
      throw new ConfigurationError("Workflow transition requires task_id, current state, and event.");
    }
    const definition = executor.transition(currentState, event);
    const persisted = await store.readTask(taskId);
    if (persisted && persisted.workflow_state !== currentState) {
      throw new ConfigurationError(`Persisted state for ${taskId} is ${persisted.workflow_state}, not ${currentState}.`);
    }
    const stateBefore = persisted?.workflow_state ?? currentState;
    const versionBefore = persisted?._version ?? 0;
    const evaluation = await ruleEvaluator.execute({
      trigger,
      context: {
        ...context,
        transition: { from: definition.from, to: definition.to, actor: context.actor }
      }
    }, async () => store.writeTask(taskId, {
      workflow_id: workflow.id,
      workflow_state: definition.to,
      updated_at: clock().toISOString()
    }, versionBefore));
    const decisive = evaluation.outcomes.find(({ passed, enforcement }) => !passed && enforcement === "blocking")
      ?? evaluation.outcomes.find(({ passed }) => !passed);

    const ownerFailure = evaluation.outcomes.find(({ rule_id, passed }) => rule_id === "WF-008" && !passed);
    if (ownerFailure) {
      const requestId = createEventId();
      pendingOwnerDecisions.set(requestId, { taskId, currentState, event, trigger, context });
      emitOwnerRequest(requestId, definition, taskId);
      return Object.freeze({
        allowed: false,
        transitioned: false,
        status: "pending_owner_decision",
        request_id: requestId,
        from: definition.from,
        event: definition.event,
        to: definition.to,
        state_before: stateBefore,
        state_after: stateBefore,
        _version: versionBefore,
        outcomes: evaluation.outcomes,
        rule_id: ownerFailure.rule_id,
        reason: "Project Owner decision required."
      });
    }

    return Object.freeze({
      allowed: evaluation.allowed,
      transitioned: evaluation.executed,
      from: definition.from,
      event: definition.event,
      to: definition.to,
      state_before: stateBefore,
      state_after: evaluation.allowed ? definition.to : stateBefore,
      _version: evaluation.executed ? versionBefore + 1 : versionBefore,
      outcomes: evaluation.outcomes,
      ...(decisive ? { rule_id: decisive.rule_id, reason: decisive.reason } : {})
    });
  }

  async function respondOwner({ requestId, approved, ownerId = "project_owner" } = {}) {
    if (typeof requestId !== "string" || !pendingOwnerDecisions.has(requestId)) throw new ConfigurationError(`Unknown owner decision request: ${requestId}.`);
    if (typeof approved !== "boolean") throw new ConfigurationError("Owner decision requires approved=true or false.");
    const pending = pendingOwnerDecisions.get(requestId);
    pendingOwnerDecisions.delete(requestId);
    if (!approved) return Object.freeze({ request_id: requestId, approved: false, continued: false, status: "owner_rejected" });
    const ownerApprovals = approved
      ? [...new Set([...(pending.context.owner_approvals ?? []), ...OWNER_APPROVAL_SCOPES])]
      : pending.context.owner_approvals ?? [];
    const result = await transition({
      ...pending,
      context: { ...pending.context, owner_approvals: ownerApprovals, owner_id: ownerId }
    });
    return Object.freeze({ request_id: requestId, approved: true, continued: result.allowed, status: result.allowed ? "owner_approved" : result.status ?? "owner_approval_denied", transition: result });
  }

  function emitOwnerRequest(requestId, definition, taskId) {
    const event = {
      event_id: createEventId(),
      type: "workflow.state_transitioned",
      project_id: projectId,
      task_id: taskId,
      timestamp: clock().toISOString(),
      payload: {
        status: "pending_owner_decision",
        request_id: requestId,
        from: definition.from,
        event: definition.event,
        to: definition.to,
        reason: "WF-008 owner approval required."
      }
    };
    validateEvent(event);
    internalBus.emit("event", Object.freeze(event));
  }
}

export function createRuntimeStateStore({ projectRoot, fileService } = {}) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) throw new ConfigurationError("A project root is required for runtime state.");
  const path = join(projectRoot, STATE_FILE);
  let writeQueue = Promise.resolve();

  return Object.freeze({
    path,
    async readTask(taskId) {
      const state = await readState(path);
      return state.tasks[taskId] ? Object.freeze({ _version: state.tasks[taskId]._version ?? 0, ...state.tasks[taskId] }) : undefined;
    },
    async writeTask(taskId, taskState, expectedVersion = 0) {
      const operation = writeQueue.then(async () => {
        const state = await readState(path);
        const current = state.tasks[taskId];
        const currentVersion = current?._version ?? 0;
        if (currentVersion !== expectedVersion) throw new WorkflowStateConflictError(taskId, expectedVersion, currentVersion);
        const next = { ...taskState, _version: currentVersion + 1 };
        state.tasks[taskId] = next;
        await writeState(path, state, fileService);
        return Object.freeze({ ...next });
      });
      writeQueue = operation.catch(() => {});
      return operation;
    }
  });
}

export class WorkflowStateConflictError extends ConfigurationError {
  constructor(taskId, expectedVersion, actualVersion) {
    super(`Workflow state conflict for ${taskId}: expected version ${expectedVersion}, found ${actualVersion}.`);
    this.name = "WorkflowStateConflictError";
    this.code = "WORKFLOW_STATE_CONFLICT";
  }
}

async function readState(path) {
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state) || !state.tasks || typeof state.tasks !== "object" || Array.isArray(state.tasks)) {
      throw new ConfigurationError("Runtime state must contain a tasks object.");
    }
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return { tasks: {} };
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`Unable to read runtime state: ${error.message}`, { cause: error });
  }
}

async function writeState(path, state, fileService) {
  if (fileService?.atomicWrite) {
    const relative = path.startsWith(`${process.cwd()}/`) ? path.slice(process.cwd().length + 1) : path;
    await fileService.atomicWrite({ path: relative, content: `${JSON.stringify(state, null, 2)}\n`, replace: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporaryPath, path);
}
