import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ConfigurationError } from "../../shared/errors.js";
import { createWorkflowRuleEvaluator } from "../rules/workflow-rule-evaluator.js";
import { createStateMachineExecutor } from "./state-machine-executor.js";

const STATE_FILE = ".forge/runtime/state.json";

export function createWorkflowTransitionGate({ workflow, projectId, projectRoot, internalBus, executor = createStateMachineExecutor({ workflow }), ruleEvaluator = createWorkflowRuleEvaluator({ projectId, internalBus }), clock = () => new Date(), stateStore } = {}) {
  if (typeof projectId !== "string" || projectId.length === 0 || typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new ConfigurationError("A project_id and project root are required for workflow transitions.");
  }
  if (typeof executor?.transition !== "function" || typeof ruleEvaluator?.execute !== "function" || typeof clock !== "function") {
    throw new ConfigurationError("Workflow transition dependencies are invalid.");
  }
  const store = stateStore ?? createRuntimeStateStore({ projectRoot });
  if (typeof store.readTask !== "function" || typeof store.writeTask !== "function") {
    throw new ConfigurationError("Workflow state storage must read and write task state.");
  }

  return Object.freeze({ transition, statePath: store.path });

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
    }));
    const decisive = evaluation.outcomes.find(({ passed, enforcement }) => !passed && enforcement === "blocking")
      ?? evaluation.outcomes.find(({ passed }) => !passed);

    return Object.freeze({
      allowed: evaluation.allowed,
      transitioned: evaluation.executed,
      from: definition.from,
      event: definition.event,
      to: definition.to,
      state_before: stateBefore,
      state_after: evaluation.allowed ? definition.to : stateBefore,
      outcomes: evaluation.outcomes,
      ...(decisive ? { rule_id: decisive.rule_id, reason: decisive.reason } : {})
    });
  }
}

export function createRuntimeStateStore({ projectRoot } = {}) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) throw new ConfigurationError("A project root is required for runtime state.");
  const path = join(projectRoot, STATE_FILE);

  return Object.freeze({
    path,
    async readTask(taskId) {
      const state = await readState(path);
      return state.tasks[taskId] ? Object.freeze({ ...state.tasks[taskId] }) : undefined;
    },
    async writeTask(taskId, taskState) {
      const state = await readState(path);
      state.tasks[taskId] = { ...taskState };
      await writeState(path, state);
      return Object.freeze({ ...taskState });
    }
  });
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

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporaryPath, path);
}
