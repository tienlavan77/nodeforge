import { createAgentSession } from "../modules/agent/session.js";
import { createEventReplayEngine } from "../modules/recovery/event-replay-engine.js";
import { createRuntimeRecovery } from "../modules/recovery/runtime-recovery.js";
import { ConfigurationError } from "../shared/errors.js";

export function createRuntimeService({ sessionFactory = createAgentSession, memoryRetriever, createSessionId, sessionStore, eventStore, recovery, replayEngine = createEventReplayEngine() } = {}) {
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

  return Object.freeze({ startTask, pauseSession, resumeSession, getSession, getProjectMemory, getBootstrap });

  function startTask({ projectId, taskId, sessionId } = {}) {
    assertIdentity(projectId, taskId);
    const id = sessionId ?? createSessionId?.() ?? `SESSION-${taskId}`;
    if (sessionStore.load(id)) throw new ConfigurationError(`Session already exists: ${id}.`);
    const session = sessionFactory({ id });
    session.start();
    return sessionStore.save(session);
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
