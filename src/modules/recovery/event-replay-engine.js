import { ConfigurationError } from "../../shared/errors.js";

export function createEventReplayEngine() {
  return Object.freeze({ replay });

  function replay(events) {
    if (!Array.isArray(events)) throw new ConfigurationError("Event Replay requires an event array.");
    const state = { tasks: {}, sessions: {}, agents: {} };
    for (const event of events) apply(state, event);
    return Object.freeze({ state: freezeState(state) });
  }
}

function apply(state, event) {
  if (!event || typeof event !== "object" || typeof event.event_type !== "string") {
    throw new ConfigurationError("Replay events require event_type.");
  }
  const { event_type: type, metadata = {}, payload = {} } = event;
  const taskId = metadata.task_id;
  const sessionId = metadata.session_id;
  const agentId = metadata.agent_id;

  if (taskId) applyTask(state.tasks, taskId, type, payload);
  if (sessionId) applySession(state.sessions, sessionId, taskId, type, payload);
  if (agentId) applyAgent(state.agents, agentId, type, payload);
}

function applyTask(tasks, taskId, type, payload) {
  const task = tasks[taskId] ?? { status: "unknown", completed_steps: 0 };
  if (type === "agent.plan.created") {
    task.plan_steps = payload.step_count ?? task.plan_steps ?? 0;
    task.step_ids = [...(payload.step_ids ?? task.step_ids ?? [])];
  }
  if (type === "agent.step.completed") {
    task.completed_steps += 1;
    if (payload.step_id) task.completed_step_ids = [...(task.completed_step_ids ?? []), payload.step_id];
  }
  if (type === "agent.completed") task.status = "completed";
  if (type === "agent.failed") {
    task.status = "failed";
    task.failed_step = payload.failed_step;
  }
  tasks[taskId] = task;
}

function applySession(sessions, sessionId, taskId, type, payload) {
  const session = sessions[sessionId] ?? { state: "CREATED", ...(taskId ? { task_id: taskId } : {}) };
  if (type === "agent.started") session.state = payload.state ?? "RUNNING";
  if (type === "agent.completed") session.state = payload.state ?? "COMPLETED";
  if (type === "agent.failed") session.state = "FAILED";
  sessions[sessionId] = session;
}

function applyAgent(agents, agentId, type, payload) {
  const agent = agents[agentId] ?? { status: "unknown", completed_steps: 0 };
  if (type === "agent.started") agent.status = "running";
  if (type === "agent.step.completed") agent.completed_steps += 1;
  if (type === "agent.completed") agent.status = "completed";
  if (type === "agent.failed") {
    agent.status = "failed";
    agent.failed_step = payload.failed_step;
  }
  agents[agentId] = agent;
}

function freezeState(state) {
  return Object.freeze({
    tasks: Object.freeze(Object.fromEntries(Object.entries(state.tasks).map(([id, value]) => [id, Object.freeze({ ...value })]))),
    sessions: Object.freeze(Object.fromEntries(Object.entries(state.sessions).map(([id, value]) => [id, Object.freeze({ ...value })]))),
    agents: Object.freeze(Object.fromEntries(Object.entries(state.agents).map(([id, value]) => [id, Object.freeze({ ...value })])))
  });
}
