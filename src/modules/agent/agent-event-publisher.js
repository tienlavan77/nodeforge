import { randomUUID } from "node:crypto";

import { ConfigurationError } from "../../shared/errors.js";

const EVENT_TYPES = Object.freeze({
  started: "agent.started",
  planCreated: "agent.plan.created",
  stepStarted: "agent.step.started",
  stepCompleted: "agent.step.completed",
  failed: "agent.failed",
  completed: "agent.completed"
});

export function createAgentEventPublisher({ publisher, projectId, taskId, sessionId, agentId, createEventId = () => `EVT-${randomUUID()}`, clock = () => new Date() } = {}) {
  if (typeof publisher?.publish !== "function") throw new ConfigurationError("Agent Event Publisher requires an Event Publisher.");
  for (const [name, value] of Object.entries({ projectId, taskId, sessionId, agentId })) {
    if (typeof value !== "string" || value.length === 0) throw new ConfigurationError(`Agent Event Publisher requires ${name}.`);
  }
  if (typeof createEventId !== "function" || typeof clock !== "function") throw new ConfigurationError("Agent Event Publisher dependencies must be functions.");

  return Object.freeze({ publish, started, planCreated, stepStarted, stepCompleted, failed, completed });

  function publish(type, payload = {}, { eventId = createEventId() } = {}) {
    if (!Object.values(EVENT_TYPES).includes(type)) throw new ConfigurationError(`Unsupported Agent Runtime event type: ${type}.`);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ConfigurationError("Agent Runtime event payload must be an object.");
    if (typeof eventId !== "string" || eventId.length === 0) throw new ConfigurationError("Agent Runtime event_id is required.");
    return publisher.publish({
      event_id: eventId,
      type,
      project_id: projectId,
      task_id: taskId,
      session_id: sessionId,
      agent_id: agentId,
      timestamp: clock().toISOString(),
      payload,
      metadata: { source: "agent-runtime", session_id: sessionId, agent_id: agentId }
    });
  }

  function started(payload, options) { return publish(EVENT_TYPES.started, payload, options); }
  function planCreated(payload, options) { return publish(EVENT_TYPES.planCreated, payload, options); }
  function stepStarted(payload, options) { return publish(EVENT_TYPES.stepStarted, payload, options); }
  function stepCompleted(payload, options) { return publish(EVENT_TYPES.stepCompleted, payload, options); }
  function failed(payload, options) { return publish(EVENT_TYPES.failed, payload, options); }
  function completed(payload, options) { return publish(EVENT_TYPES.completed, payload, options); }
}

export { EVENT_TYPES as AGENT_RUNTIME_EVENT_TYPES };
