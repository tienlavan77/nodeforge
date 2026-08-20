import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const agentMessageSchema = require("../../../schemas/governance/agent-message.schema.json");

export function createAgentCommunicationStore({ validateMessage = createAgentMessageValidator() } = {}) {
  if (typeof validateMessage !== "function") throw new ConfigurationError("Agent Message validation must be a function.");
  const messages = [];
  const messagesById = new Map();

  return Object.freeze({ append, getById, getAll, getBySender, getByReceiver, getByCorrelationId, getByConversationId });

  function append(message) {
    validateMessage(message);
    if (messagesById.has(message.id)) throw new ConfigurationError(`Agent Message already exists: ${message.id}.`);
    const stored = Object.freeze(structuredClone(message));
    messages.push(stored);
    messagesById.set(stored.id, stored);
    return structuredClone(stored);
  }

  function getById(id) {
    assertId(id, "message");
    const message = messagesById.get(id);
    return message ? structuredClone(message) : undefined;
  }

  function getAll() {
    return messages.map((message) => structuredClone(message));
  }

  function getBySender(sender) {
    return getByParty("sender", sender);
  }

  function getByReceiver(receiver) {
    return getByParty("recipient", receiver);
  }

  function getByCorrelationId(id) {
    assertId(id, "correlation");
    return messages.filter((message) => message.correlation_id === id).map((message) => structuredClone(message));
  }

  function getByConversationId(id) {
    assertId(id, "conversation");
    return messages.filter((message) => message.conversation_id === id).map((message) => structuredClone(message));
  }

  function getByParty(field, party) {
    assertId(party, field);
    return messages.filter((message) => message[field].id === party).map((message) => structuredClone(message));
  }
}

function createAgentMessageValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(agentMessageSchema);
  const validate = ajv.getSchema(agentMessageSchema.$id);
  return (message) => {
    if (!validate(message)) throw new ConfigurationError(`Invalid Agent Message: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    return true;
  };
}

function assertId(id, subject) {
  if (typeof id !== "string" || id.length === 0) throw new ConfigurationError(`An Agent Message ${subject} id is required.`);
}
