// Handles owner chat ingestion, ticket creation, and agent streaming orchestration.
import { ConfigurationError } from "../shared/errors.js";
import { logEvent } from "../core/project-log-service.js";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createOwnerAgentStream } from "./owner-agent-stream.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const ticketSchema = require("../../../schemas/governance/ticket.schema.json");

// Creates the owner chat service handling message intake and streaming.
export function createOwnerChatService({ bus, architectureManagerId = "architecture-manager", agentRequest, agentStream, onAgentCompleted, buildAgentContext, executeAgentTool, proseTicketService, internalBus, debug = () => {}, streamBatchMs = 500, projectLogger = logEvent, protocolStorage, conversationCrudService } = {}) {
  if (typeof bus?.send !== "function") throw new ConfigurationError("Owner Chat Service requires the shared Communication Bus.");
  if (!Number.isInteger(streamBatchMs) || streamBatchMs < 1) throw new ConfigurationError("Owner Chat stream batch interval must be positive.");
  const messages = new Map();
  const conversationRounds = new Map();
  const lockedConversations = new Map();
  const statusListener = (event) => {
    const conversationId = event?.payload?.conversation_id ?? event?.metadata?.conversation_id;
    const status = event?.payload?.to ?? event?.payload?.status;
    if (!conversationId || !status) return;
    if (status === "running") lockedConversations.set(conversationId, event?.task_id ?? event?.payload?.task_id ?? true);
    if (["reviewing", "done", "failed"].includes(status)) lockedConversations.delete(conversationId);
  };
  internalBus?.on?.("node.status_change", statusListener);

  const streamAgent = typeof agentStream === "function"
    ? createOwnerAgentStream({ bus, agentStream, onAgentCompleted, executeAgentTool, debug, streamBatchMs, projectLogger, protocolStorage, enrichAgentText: (message, agentId) => enrichAgentText(message, agentId), responseMessage: (message, type, payload, suffix) => responseMessage(message, type, payload, suffix), safeLog: (logger, entry) => safeLog(logger, entry) })
    : null;

  return Object.freeze({ submit });
  function safeLog(logger, entry) { try { logger?.({ timestamp: new Date().toISOString(), ...entry }); } catch (error) { debug({ event: "project-log.error", error: error.message }); } }
  function submit(input) {
    assertMessage(input);
    const agentId = input.agent_id ?? architectureManagerId;
    const lockedTask = lockedConversations.get(input.conversation_id);
    if (lockedTask) {
      const rejected = responseMessage({ id: input.message_id, project_id: input.project_id, conversation_id: input.conversation_id, correlation_id: input.correlation_id, timestamp: input.timestamp, sender: { id: "NODE", role: "node" }, recipient: { id: agentId, role: roleForAgent(agentId) } }, "ticket.input_rejected", { status: "running", task_id: lockedTask, error: "Ticket is still running; input is locked until reviewing, done, or failed." }, `REJECTED-${input.message_id}`);
      bus.send(rejected);
      return structuredClone(rejected);
    }
    const existing = messages.get(input.message_id);
    if (existing) return { ...structuredClone(existing), duplicate: true };
    conversationCrudService?.ensure?.({ id: input.conversation_id, project_id: input.project_id, agent_id: agentId, title: input.payload.text });
    const isBuilder = agentId === "builder" || agentId === "builder-ex";
    const intent = input.payload.intent;
    if (intent !== undefined && !["normal_chat", "ticket_create"].includes(intent)) throw new ConfigurationError("Invalid owner message intent.");
    const resolvedIntent = intent ?? inferLegacyIntent(input.payload.text);
    if (isBuilder && intent === "ticket_create" && (!input.payload.ticket || typeof input.payload.ticket !== "object" || Array.isArray(input.payload.ticket)) && !(hasJsonCandidate(input.payload.text) && !isParsableJsonCandidate(input.payload.text))) {
      const missingTicket = { create_ticket: true, status: "needs_input", error_code: "missing_ticket_object", question: "payload.ticket JSON object is required for ticket_create." };
      const notice = bus.send(responseMessage({ id: input.message_id, project_id: input.project_id, conversation_id: input.conversation_id, correlation_id: input.correlation_id, timestamp: input.timestamp, sender: { id: "NODE", role: "node" }, recipient: { id: "builder-ex", role: "builder" } }, "ticket.creation", missingTicket, `TICKET-CREATE-${input.message_id}`));
      messages.set(input.message_id, Object.freeze(structuredClone(notice)));
      return structuredClone(notice);
    }
    if (isBuilder && resolvedIntent === "ticket_create" && !input.payload.ticket && hasJsonCandidate(input.payload.text) && !isParsableJsonCandidate(input.payload.text)) {
      const invalidJson = { create_ticket: true, status: "needs_input", error_code: "invalid_ticket_json", question: "Ticket JSON không hợp lệ; vui lòng kiểm tra dấu ngoặc kép và xuống dòng trong chuỗi." };
      const notice = bus.send(responseMessage({ id: input.message_id, project_id: input.project_id, conversation_id: input.conversation_id, correlation_id: input.correlation_id, timestamp: input.timestamp, sender: { id: "NODE", role: "node" }, recipient: { id: "builder-ex", role: "builder" } }, "ticket.creation", invalidJson, `TICKET-CREATE-${input.message_id}`));
      messages.set(input.message_id, Object.freeze(structuredClone(notice)));
      return structuredClone(notice);
    }
    const proseResult = isBuilder && resolvedIntent === "ticket_create" && (input.payload.ticket && typeof proseTicketService?.createFromObject === "function"
      ? proseTicketService.createFromObject(input.payload.ticket, { projectId: input.project_id, timestamp: input.timestamp, sourceId: input.message_id })
      : proseTicketService?.parse?.(input.payload.text, { projectId: input.project_id, timestamp: input.timestamp, sourceId: input.message_id }));
    if (proseResult?.create_ticket) {
      const notice = bus.send(responseMessage({ id: input.message_id, project_id: input.project_id, conversation_id: input.conversation_id, correlation_id: input.correlation_id, timestamp: input.timestamp, sender: { id: "NODE", role: "node" }, recipient: { id: "builder-ex", role: "builder" } }, "ticket.creation", proseResult, `TICKET-CREATE-${input.message_id}`));
      messages.set(input.message_id, Object.freeze(structuredClone(notice)));
      return structuredClone(notice);
    }
    const round = (conversationRounds.get(input.conversation_id) ?? 0) + 1;
    conversationRounds.set(input.conversation_id, round);
    const message = {
      id: input.message_id,
      project_id: input.project_id,
      sender: { id: input.sender_id ?? "project-owner", role: "project_owner" },
      recipient: { id: agentId, role: roleForAgent(agentId) },
      message_type: "owner.message",
      conversation_id: input.conversation_id,
      correlation_id: input.correlation_id,
      payload: { text: input.payload.text, intent: resolvedIntent, round, ...(input.payload.task ? { task: normalizeTask(input.payload.task, input) } : {}) },
      timestamp: input.timestamp
    };
    // Bus persists via the canonical Communication Store before dispatching.
    const persisted = bus.send(message);
    persistProtocolMessage(persisted, round, "request");
    safeLog(projectLogger, { event_name: "owner.message", level: "info", status: "info", message: "Owner message received.", task_id: message.payload.task?.id ?? message.id, ticket_id: message.payload.task?.id, conversation_id: message.conversation_id, source: "owner-chat-service" });
    messages.set(persisted.id, Object.freeze(structuredClone(persisted)));
    if (isBuilder) {
      // Builder coding is started from Ticket Run; direct chat cannot dispatch it.
      bus.send(responseMessage(persisted, "ticket.status", {
        command: false,
        status: "ticket_required",
        error_code: "BUILDER_TICKET_REQUIRED",
        error: "Builder coding requests must use Ticket Run; direct chat execution is disabled."
      }, `TICKET-REQUIRED-${input.message_id}`));
    } else if (typeof streamAgent === "function") void streamAgent(persisted, agentId);
    else if (typeof agentRequest === "function") void requestRealAgent(persisted, agentId);
    return structuredClone(persisted);
  }
  // Adds available project context to agent requests.
  async function enrichAgentText(message, agentId) {
    if (agentId !== "builder" || typeof buildAgentContext !== "function") return message.payload.text;
    try {
      const context = await buildAgentContext({ message, agentId });
      return context ? `${message.payload.text}\n\nContext:\n${context}` : message.payload.text;
    // eslint-disable-next-line no-silent-catch -- Context lookup is best-effort; the Builder still receives the task.
    } catch (error) {
      // Context lookup is best-effort; the Builder can still receive the task.
      return message.payload.text;
    }
  }

  async function requestRealAgent(message, agentId) {
    try {
      const result = await agentRequest({ agentId, payload: { text: await enrichAgentText(message, agentId), ...(message.payload.task ? { task: message.payload.task } : {}) }, correlationId: message.correlation_id });
      persistProtocolMessage({ ...message, payload: result.payload ?? {} }, message.payload.round ?? 1, "response");
      bus.send(responseMessage(message, streamEventType(agentId, "message.received"), { text: result.payload?.text, response_id: result.payload?.response_id, agent_status: "COMPLETED" }));
      await onAgentCompleted?.({ message, agentId, text: result.payload?.text ?? "" });
    } catch (error) {
      bus.send(responseMessage(message, streamEventType(agentId, "error"), { error: error.message, agent_status: "FAILED" }));
    }
  }
  function persistProtocolMessage(message, round, direction) {
    if (!protocolStorage?.save || !message?.conversation_id) return;
    const taskId = message.payload?.task?.id ?? message.payload?.ticket?.id ?? message.id.replace(/[^A-Za-z0-9._-]/g, "-");
    const ref = `task/${taskId}/round_${round}/${direction}`;
    Promise.resolve(protocolStorage.save(ref, message, { schemaId: direction === "request" ? "forge-envelope" : "forge-response" }))
      .catch((error) => debug({ event: "protocol-storage.persist.error", ref, error: error.message }));
  }
  function responseMessage(message, type, payload, suffix = type === "architecture.error" ? "ERROR" : "REAL") {
    return { id: `MSG-ARCHITECTURE-${suffix}-${message.id}`, project_id: message.project_id,
      sender: { id: message.recipient.id, role: message.recipient.role }, recipient: { id: "NODE", role: "node" }, message_type: type,
      conversation_id: message.conversation_id, correlation_id: message.correlation_id, payload, timestamp: new Date().toISOString() };
  }
}

// Checks whether text contains a JSON candidate.
function hasJsonCandidate(text) { return /[{[]/.test(String(text ?? "")); }
// Checks whether text contains valid embedded JSON.
function isParsableJsonCandidate(text) {
  const value = String(text ?? ""); const start = value.search(/[{[]/); if (start < 0) return false;
  // eslint-disable-next-line no-silent-catch -- JSON probe: non-JSON text takes the normal-chat path by design.
  try { JSON.parse(value.slice(start)); return true; } catch { return false; }
}

// Infers message intent from legacy text patterns.
function inferLegacyIntent(text) {
  const value = String(text ?? "");
  if (/^\s*(?:[-*+]\s+)?(?:\*\*)?\s*(?:title|objective|acceptance[_ ]criteria|criteria|tiêu đề|mục tiêu|tiêu chí)\s*(?:\*\*)?\s*:/im.test(value)) return "ticket_create";
  try {
    const parsed = JSON.parse(value);
    if (parsed && !Array.isArray(parsed) && ["id", "title", "objective", "acceptance_criteria"].some((field) => Object.hasOwn(parsed, field))) return "ticket_create";
  // eslint-disable-next-line no-silent-catch -- Legacy prose stays normal chat unless it exposes ticket labels.
  } catch {
    // Legacy prose remains normal chat unless it exposes explicit ticket labels.
  }
  return "normal_chat";
}

// Validates owner message required fields.
function assertMessage(input) {
  if (!input || typeof input !== "object" || typeof input.message_id !== "string" || input.message_id.length === 0
    || typeof input.project_id !== "string" || input.project_id.length === 0 || typeof input.conversation_id !== "string" || input.conversation_id.length === 0
    || typeof input.correlation_id !== "string" || input.correlation_id.length === 0 || typeof input.timestamp !== "string"
    || typeof input.payload?.text !== "string" || input.payload.text.trim().length === 0) {
    throw new ConfigurationError("Owner message requires message_id, project_id, conversation_id, correlation_id, timestamp, and text.");
  }
  if (input.payload.task !== undefined) {
    const task = input.payload.task;
    if (!task || typeof task !== "object" || typeof task.id !== "string" || typeof task.title !== "string" || typeof task.objective !== "string" || !Array.isArray(task.acceptance_criteria) || task.acceptance_criteria.length === 0) {
      throw new ConfigurationError("Direct agent task requires id, title, objective, and acceptance_criteria.");
    }
    if (!createTicketValidator()(normalizeTask(task, input)).valid) throw new ConfigurationError("Direct agent task does not match ticket schema.");
  }
}

// Normalizes a task payload with project defaults.
function normalizeTask(task, input) {
  return { ...task, project_id: task.project_id ?? input.project_id, roadmap_id: task.roadmap_id ?? "ROADMAP-DIRECT", sprint_id: task.sprint_id ?? `SPRINT-DIRECT-${task.id}`, priority: task.priority ?? "normal", provenance: task.provenance ?? { source: "project_owner", source_id: task.id, created_at: input.timestamp } };
}

// Creates a JSON schema validator for tickets.
function createTicketValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(ticketSchema);
  const validate = ajv.getSchema(ticketSchema.$id);
  return (task) => ({ valid: Boolean(validate(task)), errors: validate.errors });
}

// Maps an agent ID to its role name.
function roleForAgent(agentId) {
  return { "architecture-manager": "architecture_manager", "sprint-leader": "sprint_lead", builder: "builder", reviewer: "reviewer" }[agentId] ?? "runtime";
}

// Resolves the streaming event type for an agent.
function streamEventType(agentId, suffix) {
  return agentId === "architecture-manager" ? `architecture.${suffix}` : `${agentId}.${suffix}`;
}
