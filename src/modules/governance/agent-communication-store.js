import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const agentMessageSchema = require("../../../schemas/governance/agent-message.schema.json");

const SENSITIVE = /(?:api[_-]?key|credential|secret|password|token|authorization)/i;
const CONVERSATION_DIR = "conversations";
const LEGACY_TABLE = "agent_communications_legacy_raw";

export function createAgentCommunicationStore({ validateMessage = createAgentMessageValidator(), database } = {}) {
  if (typeof validateMessage !== "function") throw new ConfigurationError("Agent Message validation must be a function.");
  if (database !== undefined && (!database?.run || !database?.all)) throw new ConfigurationError("Persistent Agent Communication Store requires a SQLite database.");
  const messages = [];
  const messagesById = new Map();
  const storageRoot = database ? dirname(database.databasePath ?? "") : undefined;
  if (database) load();

  return Object.freeze({ append, getById, getAll, getBySender, getByReceiver, getByCorrelationId, getByConversationId, load });

  function append(message) {
    validateMessage(message);
    if (messagesById.has(message.id)) throw new ConfigurationError(`Agent Message already exists: ${message.id}.`);
    const stored = Object.freeze(redact(structuredClone(message)));
    if (database) {
      const location = appendRawMessage(storageRoot, stored);
      database.run(`INSERT INTO agent_communications (
        message_id, project_id, agent_id, sender_id, receiver_id, conversation_id, correlation_id,
        message_type, timestamp, raw_file, byte_offset, byte_length
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        stored.id, stored.project_id, stored.sender.id, stored.sender.id, stored.recipient.id, stored.conversation_id ?? null,
        stored.correlation_id ?? null, stored.message_type, stored.timestamp, location.raw_file, location.byte_offset, location.byte_length
      ]);
    }
    if (!database) messages.push(stored);
    messagesById.set(stored.id, database ? true : stored);
    return structuredClone(stored);
  }

  function getById(id) {
    assertId(id, "message");
    if (database) return readIndexed("WHERE message_id = ?", [id])[0];
    const message = messagesById.get(id);
    return message ? structuredClone(message) : undefined;
  }

  function getAll() {
    if (database) return readIndexed();
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
    if (database) return readIndexed("WHERE correlation_id = ?", [id]);
    return messages.filter((message) => message.correlation_id === id).map((message) => structuredClone(message));
  }

  function getByConversationId(id) {
    assertId(id, "conversation");
    if (database) return readIndexed("WHERE conversation_id = ?", [id]);
    return messages.filter((message) => message.conversation_id === id).map((message) => structuredClone(message));
  }

  function load() {
    if (!database) return getAll();
    ensureTable(database);
    messages.splice(0, messages.length);
    messagesById.clear();
    for (const { message_id } of database.all("SELECT message_id FROM agent_communications ORDER BY sequence")) messagesById.set(message_id, true);
    return getAll();
  }

  function getByParty(field, party) {
    assertId(party, field);
    if (database) return readIndexed(`WHERE ${field === "sender" ? "sender_id" : "receiver_id"} = ?`, [party]);
    return messages.filter((message) => message[field].id === party).map((message) => structuredClone(message));
  }

  function readIndexed(where = "", parameters = []) {
    return database.all(`SELECT raw_file, byte_offset, byte_length FROM agent_communications ${where} ORDER BY sequence`, parameters)
      .map((row) => structuredClone(readRawMessage(storageRoot, row)));
  }
}

function ensureTable(database) {
  migrateLegacyRawTable(database);
  database.run(`CREATE TABLE IF NOT EXISTS agent_communications (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    conversation_id TEXT,
    correlation_id TEXT,
    message_type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    raw_file TEXT NOT NULL,
    byte_offset INTEGER NOT NULL,
    byte_length INTEGER NOT NULL
  )`);
  database.run("CREATE INDEX IF NOT EXISTS agent_communications_project ON agent_communications (project_id, sequence)");
  database.run("CREATE INDEX IF NOT EXISTS agent_communications_agent ON agent_communications (agent_id, sequence)");
  database.run("CREATE INDEX IF NOT EXISTS agent_communications_sender ON agent_communications (sender_id, sequence)");
  database.run("CREATE INDEX IF NOT EXISTS agent_communications_receiver ON agent_communications (receiver_id, sequence)");
  database.run("CREATE INDEX IF NOT EXISTS agent_communications_conversation ON agent_communications (conversation_id, sequence)");
  database.run("CREATE INDEX IF NOT EXISTS agent_communications_correlation ON agent_communications (correlation_id, sequence)");
}

function migrateLegacyRawTable(database) {
  const columns = tableColumns(database, "agent_communications");
  if (!columns.includes("message_json") || columns.includes("raw_file")) return;
  if (!database.databasePath) throw new ConfigurationError("Persistent Agent Communication Store requires databasePath for file-backed migration.");
  const storageRoot = dirname(database.databasePath);
  const legacyRows = database.all("SELECT sequence, message_id, sender_id, receiver_id, conversation_id, correlation_id, message_json FROM agent_communications ORDER BY sequence");
  const legacyName = nextLegacyTableName(database);
  database.run(`ALTER TABLE agent_communications RENAME TO ${legacyName}`);
  database.run(`CREATE TABLE agent_communications (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    conversation_id TEXT,
    correlation_id TEXT,
    message_type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    raw_file TEXT NOT NULL,
    byte_offset INTEGER NOT NULL,
    byte_length INTEGER NOT NULL
  )`);
  for (const row of legacyRows) {
    const stored = redact(JSON.parse(row.message_json));
    const location = appendRawMessage(storageRoot, stored);
    database.run(`INSERT INTO agent_communications (
      sequence, message_id, project_id, agent_id, sender_id, receiver_id, conversation_id, correlation_id,
      message_type, timestamp, raw_file, byte_offset, byte_length
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      row.sequence, stored.id, stored.project_id, stored.sender.id, stored.sender.id, stored.recipient.id,
      stored.conversation_id ?? null, stored.correlation_id ?? null, stored.message_type, stored.timestamp,
      location.raw_file, location.byte_offset, location.byte_length
    ]);
  }
}

function tableColumns(database, table) {
  return database.all(`PRAGMA table_info(${table})`).map(({ name }) => name);
}

function nextLegacyTableName(database) {
  if (tableColumns(database, LEGACY_TABLE).length === 0) return LEGACY_TABLE;
  let suffix = 1;
  while (tableColumns(database, `${LEGACY_TABLE}_${suffix}`).length > 0) suffix += 1;
  return `${LEGACY_TABLE}_${suffix}`;
}

function appendRawMessage(storageRoot, message) {
  if (!storageRoot) throw new ConfigurationError("Persistent Agent Communication Store requires databasePath for raw file storage.");
  const relativeFile = join(CONVERSATION_DIR, `${fileKey(message.conversation_id ?? "__unassigned")}.jsonl`);
  const filePath = join(storageRoot, relativeFile);
  mkdirSync(dirname(filePath), { recursive: true });
  const byte_offset = existsSync(filePath) ? statSync(filePath).size : 0;
  const line = `${JSON.stringify(message)}\n`;
  writeFileSync(filePath, line, { flag: "a" });
  return { raw_file: relativeFile, byte_offset, byte_length: Buffer.byteLength(line) };
}

function readRawMessage(storageRoot, row) {
  const filePath = join(storageRoot, row.raw_file);
  const buffer = Buffer.alloc(row.byte_length);
  const descriptor = openSync(filePath, "r");
  try {
    readSync(descriptor, buffer, 0, row.byte_length, row.byte_offset);
  } finally {
    closeSync(descriptor);
  }
  return JSON.parse(buffer.toString("utf8").trimEnd());
}

function fileKey(value) {
  return Buffer.from(value).toString("base64url");
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
