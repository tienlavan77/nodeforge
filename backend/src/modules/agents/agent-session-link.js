import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../../schemas/core/common.schema.json");
const agentSchema = require("../../../../schemas/core/agent.schema.json");

export function createCapabilityScopesValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(agentSchema);
  const validate = ajv.compile({
    oneOf: [
      { $ref: `${agentSchema.$id}#/$defs/ai_capability_scopes` },
      { $ref: `${agentSchema.$id}#/$defs/node_capability_scopes` }
    ]
  });

  return (capabilityScopes) => {
    if (!validate(capabilityScopes)) {
      throw new ConfigurationError(`Invalid capability_scopes declaration: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    }
    return true;
  };
}

export function linkAgentSessions({ agent, sessionStore, validateCapabilityScopes = createCapabilityScopesValidator() } = {}) {
  if (!agent?.on || !agent?.off || !sessionStore?.create || !sessionStore?.close) {
    throw new ConfigurationError("An agent process and session store are required for session linkage.");
  }

  const events = new EventEmitter();
  const activeSessions = new Map();
  const onMessage = (envelope) => {
    const { message, sender } = envelope;
    if (message.type === "sessions.start") startSession(sender.id, message);
    if (message.type === "sessions.stop") stopSession(sender.id, message);
  };
  agent.on("message", onMessage);

  function startSession(agentId, command) {
    try {
      validateCapabilityScopes(command.payload?.capability_scopes);
    } catch (error) {
      events.emit("protocol_error", error);
      return;
    }
    // capability declared, not yet enforced: Rule Engine enforcement is Sprint 5 scope.
    const session = sessionStore.create({ taskId: command.task_id, agents: [agentId], capabilityScopes: command.payload.capability_scopes });
    activeSessions.set(agentId, session.id);
    events.emit("started", session);
  }

  function stopSession(agentId, command) {
    const sessionId = command.session_id ?? activeSessions.get(agentId);
    if (!sessionId) {
      events.emit("protocol_error", new ConfigurationError("sessions.stop requires an active session for its sender."));
      return;
    }
    const session = sessionStore.close(sessionId);
    if (!session) {
      events.emit("protocol_error", new ConfigurationError(`Session ${sessionId} does not exist.`));
      return;
    }
    if (activeSessions.get(agentId) === sessionId) activeSessions.delete(agentId);
    events.emit("stopped", session);
  }

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
      activeSessions.clear();
    }
  });
}
