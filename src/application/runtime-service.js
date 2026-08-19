import { createAgentSession } from "../modules/agent/session.js";
import { ConfigurationError } from "../shared/errors.js";

export function createRuntimeService({ sessionFactory = createAgentSession, memoryRetriever, createSessionId } = {}) {
  if (typeof sessionFactory !== "function") throw new ConfigurationError("Runtime Service requires a session factory.");
  if (typeof memoryRetriever?.retrieve !== "function") throw new ConfigurationError("Runtime Service requires a Memory Retriever.");
  if (createSessionId !== undefined && typeof createSessionId !== "function") throw new ConfigurationError("Runtime Service session ID factory must be a function.");
  const sessions = new Map();

  return Object.freeze({ startTask, pauseSession, resumeSession, getSession, getProjectMemory });

  function startTask({ projectId, taskId, sessionId } = {}) {
    assertIdentity(projectId, taskId);
    const id = sessionId ?? createSessionId?.() ?? `SESSION-${taskId}`;
    if (sessions.has(id)) throw new ConfigurationError(`Session already exists: ${id}.`);
    const session = sessionFactory({ id });
    session.start();
    sessions.set(id, { projectId, taskId, session });
    return session.getSnapshot();
  }

  function pauseSession(sessionId) {
    const entry = getEntry(sessionId);
    entry.session.pause();
    return entry.session.getSnapshot();
  }

  function resumeSession(sessionId) {
    const entry = getEntry(sessionId);
    entry.session.resume();
    return entry.session.getSnapshot();
  }

  function getSession(sessionId) {
    return getEntry(sessionId).session.getSnapshot();
  }

  function getProjectMemory({ projectId, taskId, query = "", domain } = {}) {
    assertIdentity(projectId, taskId);
    return memoryRetriever.retrieve({ projectId, taskId, query, domain });
  }

  function getEntry(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new ConfigurationError("A session_id is required.");
    const entry = sessions.get(sessionId);
    if (!entry) throw new ConfigurationError(`Unknown Agent Session: ${sessionId}.`);
    return entry;
  }
}

function assertIdentity(projectId, taskId) {
  if (typeof projectId !== "string" || projectId.length === 0 || typeof taskId !== "string" || taskId.length === 0) {
    throw new ConfigurationError("Runtime Service requires projectId and taskId.");
  }
}
