import { randomUUID } from "node:crypto";
import { createAgentSession } from "../modules/agent/session.js";
import { createEventReplayEngine } from "../modules/recovery/event-replay-engine.js";
import { createRuntimeRecovery } from "../modules/recovery/runtime-recovery.js";
import { ConfigurationError } from "../shared/errors.js";

export function createRuntimeService({ sessionFactory = createAgentSession, memoryRetriever, createSessionId, sessionStore, eventStore, recovery, replayEngine = createEventReplayEngine(), agentRuntime, publisher, logger = console, taskStore, now = () => new Date().toISOString() } = {}) {
  if (typeof sessionFactory !== "function") throw new ConfigurationError("Runtime Service requires a session factory.");
  if (typeof memoryRetriever?.retrieve !== "function") throw new ConfigurationError("Runtime Service requires a Memory Retriever.");
  if (createSessionId !== undefined && typeof createSessionId !== "function") throw new ConfigurationError("Runtime Service session ID factory must be a function.");
  if (typeof sessionStore?.save !== "function" || typeof sessionStore?.load !== "function" || typeof sessionStore?.loadAll !== "function") throw new ConfigurationError("Runtime Service requires an Agent Session Store.");
  if (typeof eventStore?.getAll !== "function") throw new ConfigurationError("Runtime Service requires a Persistent Event Store.");
  if (recovery !== undefined && typeof recovery?.recover !== "function") throw new ConfigurationError("Runtime Service recovery must provide recover().");
  if (typeof replayEngine?.replay !== "function") throw new ConfigurationError("Runtime Service requires an Event Replay Engine.");
  const runtimeRecovery = recovery ?? createRuntimeRecovery({ sessionStore });
  const bootstrap = Object.freeze({
    recovery: runtimeRecovery.recover(),
    replay: replayEngine.replay(eventStore.getAll())
  });

  return Object.freeze({ startTask, finishTask, pauseSession, resumeSession, getSession, getProjectMemory, getBootstrap });

  function startTask({ projectId, taskId, sessionId, query = "", domain, runAgent = true } = {}) {
    assertIdentity(projectId, taskId);
    const id = sessionId ?? createSessionId?.() ?? `SESSION-${taskId}`;
    if (sessionStore.load(id)) throw new ConfigurationError(`Session already exists: ${id}.`);
    if (typeof taskStore?.get === "function" && typeof taskStore?.create === "function" && !taskStore.get(taskId)) {
      taskStore.create({ id: taskId, type: "custom", title: query.trim() || taskId, status: "pending", created_at: now() });
    }
    const session = sessionFactory({ id });
    session.start();
    const snapshot = sessionStore.save(session);
    if (runAgent && typeof agentRuntime?.run === "function") {
      void Promise.resolve().then(() => agentRuntime.run({ projectId, taskId, query, domain }))
        .then((result) => {
          session.complete();
          sessionStore.save(session);
          publishAgentEvent("agent.completed", { project_id: projectId, task_id: taskId, session_id: snapshot.id, result });
        })
        .catch((error) => {
          try { session.fail(error); sessionStore.save(session); } catch (stateError) { logger.error?.("Agent session state update failed", { error: stateError.message }); }
          try { logger.error?.("Agent runtime execution failed", { project_id: projectId, task_id: taskId, session_id: snapshot.id, error: error.message }); } catch { /* logging must not affect the HTTP response */ }
          publishAgentEvent("agent.failed", { project_id: projectId, task_id: taskId, session_id: snapshot.id, error: error.message });
        });
    }
    return snapshot;
  }

  function finishTask(sessionId, { failed = false } = {}) {
    const snapshot = getStoredSession(sessionId);
    const session = restoreSession(snapshot);
    if (failed) session.fail(new Error("Real Agent orchestration failed.")); else session.complete();
    return sessionStore.save(session);
  }

  function publishAgentEvent(type, payload) {
    const { project_id: projectId, task_id: taskId, session_id: sessionId, error, result } = payload;
    try {
      publisher?.publish?.({
        event_id: `EVT-${randomUUID()}`,
        type,
        project_id: projectId,
        task_id: taskId,
        timestamp: new Date().toISOString(),
        payload: { ...(result !== undefined ? { result } : {}), ...(error !== undefined ? { error } : {}) },
        metadata: { source: "runtime-service", session_id: sessionId, conversation_id: `CONV-${taskId}` }
      });
    } catch (publishError) {
      try { logger.error?.("Agent event publishing failed", { type, error: publishError.message }); } catch { /* best effort */ }
    }
  }

  function pauseSession(sessionId) {
    const session = restoreSession(getStoredSession(sessionId));
    session.pause();
    return sessionStore.save(session);
  }

  function resumeSession(sessionId) {
    const session = restoreSession(getStoredSession(sessionId));
    session.resume();
    return sessionStore.save(session);
  }

  function getSession(sessionId) {
    return getStoredSession(sessionId);
  }

  function getProjectMemory({ projectId, taskId, query = "", domain } = {}) {
    assertIdentity(projectId, taskId);
    return memoryRetriever.retrieve({ projectId, taskId, query, domain });
  }

  function getStoredSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new ConfigurationError("A session_id is required.");
    const snapshot = sessionStore.load(sessionId);
    if (!snapshot) throw new ConfigurationError(`Unknown Agent Session: ${sessionId}.`);
    return structuredClone(snapshot);
  }

  function getBootstrap() {
    return structuredClone(bootstrap);
  }

  function restoreSession(snapshot) {
    const session = sessionFactory({ id: snapshot.id });
    if (snapshot.state === "RUNNING") session.start();
    if (snapshot.state === "PAUSED") {
      session.start();
      session.pause();
    }
    if (snapshot.state === "COMPLETED") {
      session.start();
      session.complete();
    }
    if (snapshot.state === "FAILED") session.fail(new Error("Restored failed Agent Session."));
    return session;
  }
}

function assertIdentity(projectId, taskId) {
  if (typeof projectId !== "string" || projectId.length === 0 || typeof taskId !== "string" || taskId.length === 0) {
    throw new ConfigurationError("Runtime Service requires projectId and taskId.");
  }
}
