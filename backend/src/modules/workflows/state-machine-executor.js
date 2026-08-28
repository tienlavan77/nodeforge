import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const workflowSchema = require("../../../schemas/project/workflow.schema.json");

export class WorkflowTransitionError extends ConfigurationError {
  constructor(message) {
    super(message);
    this.name = "WorkflowTransitionError";
    this.code = "WORKFLOW_TRANSITION_REJECTED";
  }
}

export function createStateMachineExecutor({ workflow, validateWorkflow = createWorkflowValidator() } = {}) {
  if (typeof validateWorkflow !== "function") throw new ConfigurationError("Workflow validation must be a function.");
  validateWorkflow(workflow);
  assertWorkflowGraph(workflow);

  const states = new Set(workflow.states);
  const events = new Set(workflow.transitions.map(({ event }) => event));
  const transitions = new Map();
  for (const transition of workflow.transitions) {
    const key = transitionKey(transition.from, transition.event);
    if (transitions.has(key)) throw new ConfigurationError(`Workflow has duplicate transition for ${transition.from} and ${transition.event}.`);
    transitions.set(key, Object.freeze({ from: transition.from, event: transition.event, to: transition.to }));
  }

  return Object.freeze({
    initialState: workflow.initial_state,
    transition(currentState, event) {
      if (!states.has(currentState)) throw new WorkflowTransitionError(`Unknown workflow state: ${currentState}.`);
      if (!events.has(event)) throw new WorkflowTransitionError(`Unknown workflow event: ${event}.`);
      const transition = transitions.get(transitionKey(currentState, event));
      if (!transition) throw new WorkflowTransitionError(`No transition from ${currentState} for event ${event}.`);
      return transition;
    }
  });
}

export async function loadWorkflowDefinition(workflowPath) {
  if (typeof workflowPath !== "string" || workflowPath.length === 0) throw new ConfigurationError("A workflow JSON path is required.");
  try {
    const workflow = JSON.parse(await readFile(workflowPath, "utf8"));
    // $schema identifies the external JSON Schema; it is not workflow state-machine data.
    delete workflow.$schema;
    return workflow;
  } catch (error) {
    throw new ConfigurationError(`Unable to load workflow definition: ${error.message}`, { cause: error });
  }
}

export function createWorkflowValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(workflowSchema);
  const validate = ajv.getSchema(workflowSchema.$id);
  return (workflow) => {
    if (!validate(workflow)) throw new ConfigurationError(`Invalid workflow: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    return true;
  };
}

function assertWorkflowGraph(workflow) {
  const states = new Set(workflow.states);
  if (states.size !== workflow.states.length) throw new ConfigurationError("Workflow states must be unique.");
  if (!states.has(workflow.initial_state)) throw new ConfigurationError("Workflow initial_state must be declared in states.");
  for (const state of workflow.terminal_states ?? []) {
    if (!states.has(state)) throw new ConfigurationError(`Workflow terminal state is not declared: ${state}.`);
  }
  for (const transition of workflow.transitions) {
    if (!states.has(transition.from) || !states.has(transition.to)) {
      throw new ConfigurationError(`Workflow transition references an undeclared state: ${transition.from} -> ${transition.to}.`);
    }
  }
}

function transitionKey(state, event) {
  return `${state}\u0000${event}`;
}
