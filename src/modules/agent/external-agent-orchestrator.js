import { createAgentEventPublisher } from "./agent-event-publisher.js";
import { ConfigurationError } from "../../shared/errors.js";

export function createExternalAgentOrchestrator({ builder, reviewer, publisher, summaries, memory, createSessionId, createAgentId, clock } = {}) {
  assertAgent(builder, "Builder");
  assertAgent(reviewer, "Reviewer");
  if (typeof publisher?.publish !== "function") throw new ConfigurationError("External Agent Orchestrator requires an Event Publisher.");
  if (typeof summaries?.build !== "function" || typeof memory?.build !== "function") throw new ConfigurationError("External Agent Orchestrator requires Summary and Memory stores.");
  if (createSessionId !== undefined && typeof createSessionId !== "function") throw new ConfigurationError("Session ID factory must be a function.");
  if (createAgentId !== undefined && typeof createAgentId !== "function") throw new ConfigurationError("Agent ID factory must be a function.");

  return Object.freeze({ run });

  async function run({ projectId, taskId, task, context = {}, sessionId = createSessionId?.() ?? `SESSION-${taskId}`, agentId = createAgentId?.() ?? builder.id } = {}) {
    if (typeof projectId !== "string" || projectId.length === 0 || typeof taskId !== "string" || taskId.length === 0) {
      throw new ConfigurationError("External Agent Orchestrator requires projectId and taskId.");
    }
    if (!builder.canHandle(task)) throw new ConfigurationError("Builder Agent cannot handle this task.");
    if (!reviewer.canHandle({ ...task, type: "review" })) throw new ConfigurationError("Reviewer Agent cannot handle this task.");
    const events = createAgentEventPublisher({ publisher, projectId, taskId, sessionId, agentId, ...(clock ? { clock } : {}) });
    let eventsPublished = 0;
    const emit = (method, payload) => {
      const result = events[method](payload);
      if (result.accepted) eventsPublished += 1;
      return result;
    };

    emit("started", { state: "RUNNING" });
    const buildResult = await builder.execute({ ...context, task, projectId, taskId });
    emit("planCreated", { step_count: 0, agent_id: builder.id });
    if (buildResult.status !== "completed") {
      emit("failed", { agent_id: builder.id, result: buildResult.status });
      return { status: "failed", buildResult, reviewResult: null, eventsPublished };
    }
    const reviewResult = await reviewer.execute({ ...context, task: { ...task, type: "review" }, projectId, taskId, buildResult });
    if (reviewResult.status !== "approved") {
      emit("failed", { agent_id: reviewer.id, result: reviewResult.status });
      return { status: "review_changes_requested", buildResult, reviewResult, eventsPublished };
    }
    emit("completed", { result: "completed", long_term_fact: `Agent completed: ${task.title ?? taskId}.`, state: "COMPLETED" });
    const summary = summaries.build(taskId);
    const projectMemory = memory.build(projectId);
    return { status: "completed", buildResult, reviewResult, eventsPublished, summary, projectMemory };
  }
}

function assertAgent(agent, label) {
  if (typeof agent?.canHandle !== "function" || typeof agent?.execute !== "function") {
    throw new ConfigurationError(`${label} Agent Contract is required.`);
  }
}
