import { randomUUID } from "node:crypto";

import { ConfigurationError } from "../../shared/errors.js";
import { createNodeEventValidator } from "../watcher/debounced-watcher.js";

export function createConcurrentModificationDetector({ database, internalBus, projectId, participants = [], windowMs = 2000, clock = () => new Date(), createEventId = () => `EVT-${randomUUID()}`, validateEvent = createNodeEventValidator() } = {}) {
  if (!database?.run || !database?.all || !internalBus?.emit || typeof projectId !== "string" || projectId.length === 0) {
    throw new ConfigurationError("A SQLite database, internal bus, and project_id are required for concurrent modification detection.");
  }
  if (!Array.isArray(participants) || !Number.isInteger(windowMs) || windowMs <= 0) {
    throw new ConfigurationError("participants and a positive concurrent modification windowMs are required.");
  }

  ensureTouchTable(database);
  // MVP observations do not survive process restart, so stale rows cannot form false conflicts.
  database.run("DELETE FROM session_file_touches");

  const sessionByAgentId = new Map();
  const emittedPairs = new Map();
  const bindings = participants.map(bindParticipant);

  function bindParticipant({ agent, sessionLink } = {}) {
    if (!agent?.on || !agent?.off || !sessionLink?.on || !sessionLink?.off) {
      throw new ConfigurationError("Each concurrent modification participant requires an agent and session link.");
    }
    const onStarted = (session) => {
      for (const agentId of session.agents ?? []) sessionByAgentId.set(agentId, session.id);
    };
    const onStopped = (session) => removeSession(session.id);
    const onMessage = (envelope) => {
      if (envelope.message?.type !== "agents.report_touch") return;
      reportTouch(sessionByAgentId.get(envelope.sender.id), envelope.message.payload?.path);
    };
    sessionLink.on("started", onStarted);
    sessionLink.on("stopped", onStopped);
    agent.on("message", onMessage);
    return { agent, sessionLink, onStarted, onStopped, onMessage };
  }

  function reportTouch(sessionId, path) {
    if (!sessionId || typeof path !== "string" || path.length === 0) return;
    // MVP warning only: an Agent declaration can be inaccurate and is not proof of a filesystem write.
    const now = clock().getTime();
    prune(now);
    database.run(
      `INSERT INTO session_file_touches (session_id, path, touched_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id, path) DO UPDATE SET touched_at = excluded.touched_at`,
      [sessionId, path, now]
    );

    const openSessions = new Set(sessionByAgentId.values());
    const others = database.all(
      "SELECT session_id FROM session_file_touches WHERE path = ? AND session_id != ? AND touched_at >= ? ORDER BY session_id",
      [path, sessionId, now - windowMs]
    ).map(({ session_id: otherSessionId }) => otherSessionId).filter((otherSessionId) => openSessions.has(otherSessionId));
    for (const otherSessionId of others) emitConflict(path, sessionId, otherSessionId, now);
  }

  function emitConflict(path, firstSessionId, secondSessionId, now) {
    const sessionIds = [firstSessionId, secondSessionId].sort();
    const key = `${path}\u0000${sessionIds[0]}\u0000${sessionIds[1]}`;
    if (emittedPairs.has(key)) return;
    emittedPairs.set(key, now);
    const event = {
      event_id: createEventId(),
      type: "agents.concurrent_modification_detected",
      project_id: projectId,
      timestamp: new Date(now).toISOString(),
      payload: { path, session_ids: sessionIds }
    };
    validateEvent(event);
    internalBus.emit("event", Object.freeze(event));
  }

  function removeSession(sessionId) {
    for (const [agentId, activeSessionId] of sessionByAgentId) {
      if (activeSessionId === sessionId) sessionByAgentId.delete(agentId);
    }
    database.run("DELETE FROM session_file_touches WHERE session_id = ?", [sessionId]);
    for (const key of emittedPairs.keys()) {
      if (key.split("\u0000").includes(sessionId)) emittedPairs.delete(key);
    }
  }

  function prune(now) {
    database.run("DELETE FROM session_file_touches WHERE touched_at < ?", [now - windowMs]);
    for (const [key, detectedAt] of emittedPairs) {
      if (detectedAt < now - windowMs) emittedPairs.delete(key);
    }
  }

  return Object.freeze({
    close() {
      for (const { agent, sessionLink, onStarted, onStopped, onMessage } of bindings) {
        agent.off("message", onMessage);
        sessionLink.off("started", onStarted);
        sessionLink.off("stopped", onStopped);
      }
      database.run("DELETE FROM session_file_touches");
      sessionByAgentId.clear();
      emittedPairs.clear();
    }
  });
}

function ensureTouchTable(database) {
  database.run(`CREATE TABLE IF NOT EXISTS session_file_touches (
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    touched_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, path)
  )`);
  database.run("CREATE INDEX IF NOT EXISTS session_file_touches_by_path_time ON session_file_touches (path, touched_at)");
}
