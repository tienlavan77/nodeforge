import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const agentMessageSchema = require("../../../schemas/governance/agent-message.schema.json");

const SENSITIVE = /(?:api[_-]?key|credential|secret|password|token|authorization)/i;

export function createAgentCommunicationStore({ validateMessage = createAgentMessageValidator(), database } = {}) {
  if (typeof validateMessage !== "function") throw new ConfigurationError("Agent Message validation must be a function.");
  if (database !== undefined && (!database?.run || !database?.all)) throw new ConfigurationError("Persistent Agent Communication Store requires a SQLite database.");
  const messages = [];
  const messagesById = new Map();
  if (database) load();

  return Object.freeze({ append, getById, getAll, getBySender, getByReceiver, getByCorrelationId, getByConversationId, load });

  function append(message) {
    validateMessage(message);
    if (messagesById.has(message.id)) throw new ConfigurationError(`Agent Message already exists: ${message.id}.`);
    const stored = Object.freeze(redact(structuredClone(message)));
    if (database) database.run("INSERT INTO agent_communications (message_id, sender_id, receiver_id, conversation_id, correlation_id, message_json) VALUES (?, ?, ?, ?, ?, ?)", [stored.id, stored.sender.id, stored.recipient.id, stored.conversation_id ?? null, stored.correlation_id ?? null, JSON.stringify(stored)]);
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

  function load() {
    if (!database) return getAll();
    ensureTable(database);
    messages.splice(0, messages.length);
    messagesById.clear();
    for (const { message_json } of database.all("SELECT message_json FROM agent_communications ORDER BY sequence")) {
      const stored = Object.freeze(JSON.parse(message_json));
      messages.push(stored);
      messagesById.set(stored.id, stored);
    }
    return getAll();
  }

  function getByParty(field, party) {
    assertId(party, field);
    return messages.filter((message) => message[field].id === party).map((message) => structuredClone(message));
  }
}

function ensureTable(database) {
  database.run(`CREATE TABLE IF NOT EXISTS agent_communications (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    conversation_id TEXT,
    correlation_id TEXT,
    message_json TEXT NOT NULL
  )`);
  database.run("CREATE INDEX IF NOT EXISTS agent_communications_sender ON agent_communications (sender_id, sequence)");
  database.run("CREATE INDEX IF NOT EXISTS agent_communications_receiver ON agent_communications (receiver_id, sequence)");
  database.run("CREATE INDEX IF NOT EXISTS agent_communications_conversation ON agent_communications (conversation_id, sequence)");
  database.run("CREATE INDEX IF NOT EXISTS agent_communications_correlation ON agent_communications (correlation_id, sequence)");
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE.test(key) ? "[REDACTED]" : redact(item)]));
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
