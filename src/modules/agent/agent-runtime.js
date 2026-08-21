import { randomUUID } from "node:crypto";

import { createAgentEventPublisher } from "./agent-event-publisher.js";
import { createActionExecutor } from "./executor.js";
import { createAgentSession } from "./session.js";
import { ConfigurationError } from "../../shared/errors.js";

export function createAgentRuntime({
  contextService,
  budgetManager,
  planningEngine,
  publisher,
  summaries,
  memory,
  createSession = createAgentSession,
  createSessionId = () => `SESSION-${randomUUID()}`,
  createAgentId = () => `AGENT-${randomUUID()}`,
  executeStep = async () => {},
  maxFacts = Number.MAX_SAFE_INTEGER,
  clock
} = {}) {
  if (typeof contextService?.buildContext !== "function") throw new ConfigurationError("Agent Runtime requires a Context Service.");
  if (typeof budgetManager?.selectFacts !== "function") throw new ConfigurationError("Agent Runtime requires a Context Budget Manager.");
  if (typeof planningEngine?.createPlan !== "function") throw new ConfigurationError("Agent Runtime requires a Planning Engine.");
  if (typeof publisher?.publish !== "function") throw new ConfigurationError("Agent Runtime requires an Event Publisher.");
  if (typeof summaries?.build !== "function" || typeof memory?.build !== "function") throw new ConfigurationError("Agent Runtime requires Summary and Memory stores.");
  if (typeof createSession !== "function" || typeof createSessionId !== "function" || typeof createAgentId !== "function" || typeof executeStep !== "function") {
    throw new ConfigurationError("Agent Runtime factories and step executor must be functions.");
  }
  if (!Number.isInteger(maxFacts) || maxFacts < 0) throw new ConfigurationError("Agent Runtime maxFacts must be a non-negative integer.");

  return Object.freeze({ run });

  async function run({ projectId, taskId, query = "", domain } = {}) {
    if (typeof projectId !== "string" || projectId.length === 0 || typeof taskId !== "string" || taskId.length === 0) {
      throw new ConfigurationError("Agent Runtime requires projectId and taskId.");
    }
    const context = await contextService.buildContext({ projectId, taskId, query, domain });
    const allFacts = [...context.projectFacts, ...context.taskFacts];
    const selectedFacts = budgetManager.selectFacts({ facts: allFacts, maxFacts });
    const task = context.currentTask;
    const plan = planningEngine.createPlan(task);
    const sessionId = createSessionId();
    const agentId = createAgentId();
    const session = createSession();
    const events = createAgentEventPublisher({ publisher, projectId, taskId, sessionId, agentId, ...(clock ? { clock } : {}) });
    let eventsPublished = 0;
    const emit = (method, payload) => {
      const result = events[method](payload);
      if (result.accepted) eventsPublished += 1;
      return result;
    };

    session.start();
    emit("started", { state: session.getState() });
    emit("planCreated", { step_count: plan.steps.length, step_ids: plan.steps.map(({ id }) => id) });

    const executor = createActionExecutor({
      executeStep: async (step) => {
        emit("stepStarted", { step_id: step.id });
        await executeStep(step, { context, selectedFacts, task, plan });
        emit("stepCompleted", { step_id: step.id });
      }
    });
    const execution = await executor.execute(plan);
    if (execution.status === "failed") {
      session.fail(new Error(`Step failed: ${execution.failedStep}`));
      emit("failed", { failed_step: execution.failedStep });
      return report({ context, selectedFacts, plan, session, execution, eventsPublished });
    }

    session.complete();
    const longTermFact = task.metadata?.long_term_fact ?? `Agent completed: ${task.title}.`;
    emit("completed", { result: "completed", long_term_fact: longTermFact, state: session.getState() });
    const summary = summaries.build(taskId);
    const projectMemory = memory.build(projectId);
    return report({ context, selectedFacts, plan, session, execution, eventsPublished, summary, projectMemory });
  }
}

function report({ context, selectedFacts, plan, session, execution, eventsPublished, summary = null, projectMemory = null }) {
  return {
    status: execution.status,
    sessionState: session.getState(),
    context,
    contextFactsRetrieved: context.projectFacts.length + context.taskFacts.length,
    factsAfterBudget: selectedFacts.length,
    plan,
    planStepsGenerated: plan.steps.length,
    execution,
    eventsPublished,
    summary,
    summaryFactsCreated: summary?.facts.length ?? 0,
    projectMemory,
    memoryFactsAvailable: projectMemory?.facts.length ?? 0
  };
}
