import { EventEmitter } from "node:events";

import { ConfigurationError } from "../../shared/errors.js";

const IDEMPOTENT_COMMAND_TYPES = new Set(["verification.run_test", "context.read_file", "workflow.transition"]);

export function createSessionCommandDispatcher({ executeCommand, getSessionId = (envelope) => envelope.message.session_id } = {}) {
  if (typeof executeCommand !== "function" || typeof getSessionId !== "function") {
    throw new ConfigurationError("Command execution and session lookup functions are required.");
  }

  // Deliberately in-memory: this cache lasts only for one running Node process.
  // Restart persistence belongs to Sprint 9 crash recovery, not this MVP.
  const processedBySession = new Map();

  return Object.freeze({
    async handle(envelope) {
      const command = envelope?.message;
      if (typeof command?.request_id !== "string" || command.request_id.length === 0) {
        throw new ConfigurationError("Agent Commands require request_id.");
      }
      const sessionId = getSessionId(envelope);
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new ConfigurationError("Agent Commands require session_id for request idempotency.");
      }

      const processed = processedBySession.get(sessionId) ?? new Map();
      processedBySession.set(sessionId, processed);
      const previous = processed.get(command.request_id);
      if (isIdempotent(command) && previous?.result) {
        return Object.freeze({ result: await previous.result, cached: true });
      }

      const result = Promise.resolve().then(() => executeCommand(command, envelope));
      if (isIdempotent(command)) processed.set(command.request_id, { result });
      try {
        const value = await result;
        return Object.freeze({ result: value, cached: false });
      } catch (error) {
        if (isIdempotent(command) && processed.get(command.request_id)?.result === result) {
          processed.delete(command.request_id);
        }
        throw error;
      }
    },
    hasProcessed(sessionId, requestId) {
      return processedBySession.get(sessionId)?.has(requestId) ?? false;
    },
    clearSession(sessionId) {
      processedBySession.delete(sessionId);
    }
  });
}

export function bindAgentCommandDispatcher({ agent, dispatcher } = {}) {
  if (!agent?.on || !agent?.off || !dispatcher?.handle) {
    throw new ConfigurationError("An agent process and command dispatcher are required.");
  }

  const events = new EventEmitter();
  const onMessage = async (envelope) => {
    if (typeof envelope.message?.request_id !== "string") return;
    try {
      const outcome = await dispatcher.handle(envelope);
      events.emit("handled", { envelope, ...outcome });
    } catch (error) {
      events.emit("command_error", { envelope, error });
    }
  };
  agent.on("message", onMessage);

  return Object.freeze({
    on(event, listener) {
      events.on(event, listener);
      return this;
    },
    off(event, listener) {
      events.off(event, listener);
      return this;
    },
    once(event, listener) {
      events.once(event, listener);
      return this;
    },
    removeListener(event, listener) {
      events.removeListener(event, listener);
      return this;
    },
    close() {
      agent.off("message", onMessage);
    }
  });
}

function isIdempotent(command) {
  return IDEMPOTENT_COMMAND_TYPES.has(command.type);
}
