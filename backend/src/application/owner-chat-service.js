import { ConfigurationError } from "../shared/errors.js";
import { logEvent } from "../core/project-log-service.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const ticketSchema = require("../../../schemas/governance/ticket.schema.json");
const agentToolSchema = require("../../../schemas/agent/agent-tool.schema.json");
const AGENT_TOOL_PROTOCOL_UNLIMITED = "\n\nAgent tool loop protocol:\n- Use code_needed only when more context is needed; request files with files_requested and a short reason.\n- When ready to submit code, use submit_code_response and return explanation plus files[].\n- Each file entry must include path, language, format, content, exists, and before_checksum.\n- Keep representation to full_content unless a diff is explicitly required.\n- If the task is a status-style result, use the matching tool kind and keep the response minimal and structured, not prose-only.\n- Never send apply_patch syntax or a bare @@ hunk.\n- Never replace a long file with a shortened reconstruction.";

export function createOwnerChatService({ bus, architectureManagerId = "architecture-manager", agentRequest, agentStream, onAgentCompleted, buildAgentContext, executeAgentTool, ticketCommandParser, proseTicketService, dispatchAgentTicket, internalBus, debug = () => {}, streamBatchMs = 500, projectLogger = logEvent, protocolStorage } = {}) {
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
    const isBuilder = agentId === "builder" || agentId === "builder-ex";
    const intent = input.payload.intent;
    if (intent !== undefined && !["normal_chat", "ticket_create", "ticket_dispatch"].includes(intent)) throw new ConfigurationError("Invalid owner message intent.");
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
    const commandResult = isBuilder && resolvedIntent === "ticket_dispatch" && ticketCommandParser?.parse?.(input.payload.text);
    if (isBuilder && /^\/ticket(?:\s|$)/i.test(String(input.payload.text ?? "")) && !commandResult?.command) {
      const notice = bus.send(responseMessage({ id: input.message_id, project_id: input.project_id, conversation_id: input.conversation_id, correlation_id: input.correlation_id, timestamp: input.timestamp, sender: { id: "NODE", role: "node" }, recipient: { id: agentId, role: roleForAgent(agentId) } }, "ticket.status", { command: true, status: "syntax_error", error: "Không nhận diện được ticket id, vui lòng kiểm tra lại cú pháp /ticket <id>." }, `TICKET-SYNTAX-${input.message_id}`));
      messages.set(input.message_id, Object.freeze(structuredClone(notice)));
      return structuredClone(notice);
    }
    if (commandResult?.command && commandResult.status !== "ready") {
      const notice = bus.send(responseMessage({ id: input.message_id, project_id: input.project_id, conversation_id: input.conversation_id, correlation_id: input.correlation_id, timestamp: input.timestamp, sender: { id: "NODE", role: "node" }, recipient: { id: "builder", role: "builder" } }, "ticket.status", commandResult, `TICKET-${input.message_id}`));
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
      // Preserve the canonical roadmap ticket for /ticket commands. The old
      // reduced shape triggered the generic direct-task fallback and replaced
      // roadmap/sprint metadata with ROADMAP-DIRECT values.
      payload: { text: input.payload.text, intent: resolvedIntent, round, ...(commandResult?.ticket ? { task: normalizeTask(commandResult.ticket, input) } : {}), ...(input.payload.task ? { task: normalizeTask(input.payload.task, input) } : {}) },
      timestamp: input.timestamp
    };
    // Bus persists via the canonical Communication Store before dispatching.
    const persisted = bus.send(message);
    // Dispatches enter the canonical Stage-1 pipeline, which persists the
    // validated task envelope at round_1/request. Do not occupy that ref with
    // the UI command envelope; Communication Store still retains the message.
    if (!(commandResult?.command && commandResult.status === "ready")) persistProtocolMessage(persisted, round, "request");
    safeLog(projectLogger, { event_name: "owner.message", level: "info", status: "info", message: "Owner message received.", task_id: message.payload.task?.id ?? message.id, ticket_id: message.payload.task?.id, conversation_id: message.conversation_id, source: "owner-chat-service" });
    messages.set(persisted.id, Object.freeze(structuredClone(persisted)));
    if (commandResult?.command && commandResult.status === "ready" && typeof dispatchAgentTicket === "function") void dispatchAgentTicket({ task_id: commandResult.ticket_id, ticket: commandResult.ticket, message: persisted, agent_id: agentId, eventSink: input.eventSink });
    else if (typeof agentStream === "function") void streamRealAgent(persisted, agentId);
    else if (typeof agentRequest === "function") void requestRealAgent(persisted, agentId);
    return structuredClone(persisted);
  }

  async function streamRealAgent(message, agentId) {
    let index = 0;
    let text = "";
    let batchText = "";
    let batchStart = 0;
    let timer;
    let emittedFirstDelta = false;
    let submittedCode = false;
    const contextRefs = new Map();
    const requestInfoFingerprints = new Set();
    const contextResults = new Map();
    const flush = () => {
      if (!batchText) return;
      const payload = { text: batchText, accumulated_text: text, chunk_index: index++, batch_start: batchStart, batch_end: index - 1 };
      batchText = "";
      batchStart = index;
      bus.sendFast(responseMessage(message, streamEventType(agentId, "message.delta"), payload, `DELTA-${index}`));
    };
    try {
      bus.send(responseMessage(message, "architecture.working", { agent_status: "WORKING" }, "WORKING"));
      const taskId = message.payload.task?.id ?? message.id;
      const initialText = `${await enrichAgentText(message, agentId)}${AGENT_TOOL_PROTOCOL_UNLIMITED}`;
      let requestPayload = { text: initialText, ...(message.payload.task ? { task: message.payload.task } : {}) };
      // Continue until the agent submits code. Context requests are agent-driven.
      let round = 0;
      while (!submittedCode) {
        round += 1;
       let requestedNextRound = false;
       debug({ event: "agent.loop.request", agent_id: agentId, task_id: taskId, round, payload: summarizePayload(requestPayload) });
       emitProgress(message, agentId, `Đang xử lý yêu cầu (vòng ${round})…`, `PROGRESS-${round}-START`);
       for await (const chunk of agentStream({ agentId, payload: requestPayload, correlationId: message.correlation_id })) {
          if (chunk.usage) {
            debug({ event: "agent.loop.usage", agent_id: agentId, task_id: taskId, round, usage: chunk.usage, cache_read_input_tokens: chunk.usage.cache_read_input_tokens ?? 0 });
          }
          if (chunk.completed) continue;
          if (chunk.tool_use) {
            const tool = chunk.tool_use.input ?? chunk.tool_use;
            debug({ event: "agent.loop.tool_use", agent_id: agentId, task_id: taskId, round, tool: summarizeValue(tool) });
            if (!validateAgentTool(tool)) throw new ConfigurationError("Invalid agent tool request.");
            if (tool.kind === "code_needed") {
              const fingerprint = requestInfoFingerprint(tool);
              const duplicate = requestInfoFingerprints.has(fingerprint);
              requestInfoFingerprints.add(fingerprint);
              if (duplicate) emitProgress(message, agentId, "Context đã cache, gửi lại bản tóm tắt…", `PROGRESS-${round}-CACHE`);
            }
            emitProgress(message, agentId, tool.kind === "code_needed" ? "Đang đọc context cần thiết…" : "Đang chuẩn bị ghi code…", `PROGRESS-${round}-${tool.kind}`);
            const fingerprint = tool.kind === "code_needed" ? requestInfoFingerprint(tool) : null;
            const result = fingerprint && contextResults.has(fingerprint)
              ? contextResults.get(fingerprint)
              : await executeAgentTool?.(tool, { message, agentId }) ?? { content: "Tool execution is unavailable." };
            if (fingerprint) contextResults.set(fingerprint, result);
            emitProgress(message, agentId, tool.kind === "code_needed" ? "Context đã sẵn sàng, đang gửi lại cho agent…" : "Đã xử lý tool…", `PROGRESS-${round}-RESULT`);
            debug({ event: "agent.loop.tool_result", agent_id: agentId, task_id: taskId, round: tool.round, result: summarizeValue(result) });
            safeLog(projectLogger, { event_name: tool.kind === "code_needed" ? "context.request" : "agent.tool_result", level: "info", status: "success", message: `Agent ${tool.kind} completed.`, task_id: taskId, ticket_id: message.payload.task?.id, conversation_id: message.conversation_id, source: "owner-chat-service" });
            bus.send(responseMessage(message, streamEventType(agentId, "tool.result"), { content: result.content ?? result, token_usage: result.token_usage ?? null }, `TOOL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
            const needsAnotherRound = tool.kind === "code_needed";
            if (needsAnotherRound) {
              const taskSummary = message.payload.task ? `${message.payload.task.title}: ${message.payload.task.objective}` : message.payload.text;
              const stateSummary = `Task ${taskId}: ${taskSummary}; context request completed; return submit_code_response when ready.`;
              const contextRef = `CTX-${taskId}-${round}-${createHash("sha256").update(String(result.content ?? "")).digest("hex").slice(0, 12)}`;
              const contextContent = String(result.content ?? "");
              contextRefs.set(contextRef, contextContent);
              const excerpt = contextContent.slice(0, 3000);
              requestPayload = { text: `task_id: ${taskId}\ncontext_ref: ${contextRef}\nstate_summary: ${stateSummary}\ncontext_status: ${result.status ?? "context_ready"}\ncontext_available: ${result.context_available !== false}\ntool_result: context stored by Node (${contextContent.length} chars)\ncontext_excerpt:\n${excerpt}\nnext_step: submit_code_response\n\nUse the context_ref for correlation. The excerpt above is the available context; do not request the same listing again. Return submit_code_response now.` };
              requestedNextRound = true;
            }
            if (tool.kind === "submit_code_response") {
              emitProgress(message, agentId, "Đã nhận code, đang hoàn tất…", `PROGRESS-${round}-SUBMIT`);
              submittedCode = true;
              // submit_code_response is the terminal agent action. Do not consume trailing
              // gateway chunks or open another request for the same task.
              break;
            }
            continue;
          }
          if (typeof chunk.text !== "string") continue;
          text += chunk.text;
          debug({ event: "agent.loop.delta", agent_id: agentId, task_id: taskId, round, text: redactPreview(chunk.text) });
          if (!chunk.text) continue;
          if (!emittedFirstDelta) {
            emittedFirstDelta = true;
            bus.sendFast(responseMessage(message, streamEventType(agentId, "message.delta"), { text: chunk.text, accumulated_text: text, chunk_index: index++, batch_start: 0, batch_end: 0 }, `DELTA-${index}`));
            continue;
          }
          batchText += chunk.text;
          if (!timer) timer = setTimeout(() => { timer = undefined; flush(); }, streamBatchMs);
       }
       if (!requestedNextRound) break;
      }
      if (timer) { clearTimeout(timer); timer = undefined; }
      flush();
      if (submittedCode) emitProgress(message, agentId, "Đang chạy kiểm tra sau khi ghi file…", "PROGRESS-VERIFY");
      if (agentId === "builder" && !submittedCode) throw new ConfigurationError("Builder must return submit_code before completing a coding task.");
      if (!submittedCode && !text.trim()) throw new ConfigurationError("Agent ended without submit_code or a non-empty response.");
      await bus.flush();
      bus.send(responseMessage(message, streamEventType(agentId, "message.received"), { text, agent_status: "COMPLETED" }, "COMPLETED"));
      persistProtocolMessage({ ...message, payload: { ...message.payload, text } }, conversationRounds.get(message.conversation_id) ?? 1, "response");
      await onAgentCompleted?.({ message, agentId, text });
    } catch (error) {
      bus.send(responseMessage(message, streamEventType(agentId, "error"), { error: error.message, agent_status: "FAILED" }, "ERROR"));
    }
  }

  function emitProgress(message, agentId, text, suffix) {
    debug({ event: "agent.loop.progress", agent_id: agentId, conversation_id: message.conversation_id, text });
    bus.sendFast(responseMessage(message, streamEventType(agentId, "message.progress"), {
      text, progress: true
    }, suffix));
  }

  function requestInfoFingerprint(tool) {
    return JSON.stringify({
      tool: tool.tool,
      target_path: tool.target_path ?? null,
      query: tool.query ?? null
    });
  }

  async function requestRealAgent(message, agentId) {
    try {
      const result = await agentRequest({ agentId, payload: { text: await enrichAgentText(message, agentId), ...(message.payload.task ? { task: message.payload.task } : {}) }, correlationId: message.correlation_id });
      persistProtocolMessage({ ...message, payload: result.payload ?? {} }, conversationRounds.get(message.conversation_id) ?? 1, "response");
      bus.send(responseMessage(message, streamEventType(agentId, "message.received"), { text: result.payload?.text, response_id: result.payload?.response_id, agent_status: "COMPLETED" }));
      await onAgentCompleted?.({ message, agentId, text: result.payload?.text ?? "" });
    } catch (error) {
      bus.send(responseMessage(message, streamEventType(agentId, "error"), { error: error.message, agent_status: "FAILED" }));
    }
  }

  function persistProtocolMessage(message, round, direction) {
    if (!protocolStorage?.save || !message?.conversation_id) return;
    const taskId = message.payload?.task?.id ?? message.payload?.ticket?.id ?? message.conversation_id.replace(/[^A-Za-z0-9._-]/g, "-");
    const ref = `task/${taskId}/round_${round}/${direction}`;
    Promise.resolve(protocolStorage.save(ref, message, { schemaId: direction === "request" ? "forge-envelope" : "forge-response" }))
      .catch((error) => debug({ event: "protocol-storage.persist.error", ref, error: error.message }));
  }

  async function enrichAgentText(message, agentId) {
    if (agentId !== "builder" || typeof buildAgentContext !== "function") return message.payload.text;
    try {
      const context = await buildAgentContext({ message, agentId });
      return context ? `${message.payload.text}\n\nContext:\n${context}` : message.payload.text;
    } catch (error) {
      // Context lookup is best-effort; the Builder can still receive the task.
      return message.payload.text;
    }
  }

  function responseMessage(message, type, payload, suffix = type === "architecture.error" ? "ERROR" : "REAL") {
    return { id: `MSG-ARCHITECTURE-${suffix}-${message.id}`, project_id: message.project_id,
      sender: { id: message.recipient.id, role: message.recipient.role }, recipient: { id: "NODE", role: "node" }, message_type: type,
      conversation_id: message.conversation_id, correlation_id: message.correlation_id, payload, timestamp: new Date().toISOString() };
  }

  function validateAgentTool(value) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(agentToolSchema);
    return Boolean(validate(value));
  }
}

function hasJsonCandidate(text) { return /[{[]/.test(String(text ?? "")); }
function isParsableJsonCandidate(text) {
  const value = String(text ?? ""); const start = value.search(/[{[]/); if (start < 0) return false;
  try { JSON.parse(value.slice(start)); return true; } catch { return false; }
}

function inferLegacyIntent(text) {
  const value = String(text ?? "");
  if (/^\/ticket(?:\s|$)/i.test(value)) return "ticket_dispatch";
  if (/^\s*(?:[-*+]\s+)?(?:\*\*)?\s*(?:title|objective|acceptance[_ ]criteria|criteria|tiêu đề|mục tiêu|tiêu chí)\s*(?:\*\*)?\s*:/im.test(value)) return "ticket_create";
  try {
    const parsed = JSON.parse(value);
    if (parsed && !Array.isArray(parsed) && ["id", "title", "objective", "acceptance_criteria"].some((field) => Object.hasOwn(parsed, field))) return "ticket_create";
  } catch {
    // Legacy prose remains normal chat unless it exposes explicit ticket labels.
  }
  return "normal_chat";
}

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

function normalizeTask(task, input) {
  return { ...task, project_id: task.project_id ?? input.project_id, roadmap_id: task.roadmap_id ?? "ROADMAP-DIRECT", sprint_id: task.sprint_id ?? `SPRINT-DIRECT-${task.id}`, priority: task.priority ?? "normal", provenance: task.provenance ?? { source: "project_owner", source_id: task.id, created_at: input.timestamp } };
}

function createTicketValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(ticketSchema);
  const validate = ajv.getSchema(ticketSchema.$id);
  return (task) => ({ valid: Boolean(validate(task)), errors: validate.errors });
}

function roleForAgent(agentId) {
  return { "architecture-manager": "architecture_manager", "sprint-leader": "sprint_lead", builder: "builder", reviewer: "reviewer" }[agentId] ?? "runtime";
}

function summarizePayload(payload) {
  const text = String(payload?.text ?? "");
  return { chars: text.length, sha256: createHash("sha256").update(text).digest("hex"), preview: redactPreview(text, 2000), has_tools: Array.isArray(payload?.tools) && payload.tools.length > 0 };
}

function summarizeValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { chars: text.length, preview: redactPreview(text, 2000) };
}

function redactPreview(value, limit = 500) {
  return String(value ?? "").replace(/(?:api[_-]?key|credential|secret|password|token|authorization)\s*[:=]\s*[^\s,}]+/gi, "$1=[REDACTED]").slice(0, limit);
}

function streamEventType(agentId, suffix) {
  return agentId === "architecture-manager" ? `architecture.${suffix}` : `${agentId}.${suffix}`;
}
