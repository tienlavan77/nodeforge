// Streams agent responses while coordinating context requests, tools, and completion events.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import { ConfigurationError } from "../shared/errors.js";

const require = createRequire(import.meta.url);
const agentToolSchema = require("../../../schemas/agent/agent-tool.schema.json");
const AGENT_TOOL_PROTOCOL = "\n\nAgent tool loop protocol:\n- Use request_info only when more context is needed; identify the lookup tool, query, and reason.\n- When ready to submit code, use submit_code and include the target path, operation, code, and files[].\n- Each additional file must include target_path, target_dir, file_operation, code_kind, and content.\n- Do not replace a long file with a shortened reconstruction.";

// Creates the streaming runner for owner conversations with tool-enabled agents.
export function createOwnerAgentStream({ bus, agentStream, onAgentCompleted, executeAgentTool, debug, streamBatchMs, projectLogger, protocolStorage, enrichAgentText, responseMessage, safeLog }) {
  return streamRealAgent;

  // Streams agent output and loops through context requests until completion.
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
      bus.sendFast(responseMessage(message, "architecture.working", { agent_status: "WORKING" }, "WORKING"));
      const taskId = message.payload.task?.id ?? message.id;
      const initialText = `${await enrichAgentText(message, agentId)}${typeof executeAgentTool === "function" ? AGENT_TOOL_PROTOCOL : ""}`;
      let requestPayload = { text: initialText, ...(message.payload.task ? { task: message.payload.task } : {}) };
      let round = 0;
      while (!submittedCode) {
        round += 1;
        let requestedNextRound = false;
        debug({ event: "agent.loop.request", agent_id: agentId, task_id: taskId, round, payload: summarizePayload(requestPayload) });
        emitProgress(message, agentId, `Đang xử lý yêu cầu (vòng ${round})…`, `PROGRESS-${round}-START`);
        for await (const chunk of agentStream({ agentId, payload: requestPayload, correlationId: message.correlation_id, conversationId: message.conversation_id })) {
          if (chunk.usage) debug({ event: "agent.loop.usage", agent_id: agentId, task_id: taskId, round, usage: chunk.usage, cache_read_input_tokens: chunk.usage.cache_read_input_tokens ?? 0 });
          if (chunk.completed) continue;
        if (chunk.tool_use) {
          const tool = chunk.tool_use.input ?? chunk.tool_use;
          debug({ event: "agent.loop.tool_use", agent_id: agentId, task_id: taskId, round, tool: summarizeValue(tool) });
          if (!validateAgentTool(tool)) throw new ConfigurationError("Invalid agent tool request.");
          if (tool.kind === "request_info") {
            const fingerprint = requestInfoFingerprint(tool);
            const duplicate = requestInfoFingerprints.has(fingerprint);
            requestInfoFingerprints.add(fingerprint);
            if (duplicate) emitProgress(message, agentId, "Context cached, reusing summary…", `PROGRESS-${round}-CACHE`);
          }
          emitProgress(message, agentId, tool.kind === "request_info" ? "Reading requested context…" : "Preparing code changes…", `PROGRESS-${round}-${tool.kind}`);
          const fingerprint = tool.kind === "request_info" ? requestInfoFingerprint(tool) : null;
          const result = fingerprint && contextResults.has(fingerprint) ? contextResults.get(fingerprint) : await executeAgentTool?.(tool, { message, agentId }) ?? { content: "Tool execution is unavailable." };
          if (fingerprint) contextResults.set(fingerprint, result);
          emitProgress(message, agentId, tool.kind === "request_info" ? "Context is ready; returning it to the agent…" : "Tool completed…", `PROGRESS-${round}-RESULT`);
          debug({ event: "agent.loop.tool_result", agent_id: agentId, task_id: taskId, round: tool.round, result: summarizeValue(result) });
          safeLog(projectLogger, { event_name: tool.kind === "request_info" ? "context.request" : "agent.tool_result", level: "info", status: "success", message: `Agent ${tool.kind} completed.`, task_id: taskId, ticket_id: message.payload.task?.id, conversation_id: message.conversation_id, source: "owner-chat-service" });
          bus.send(responseMessage(message, streamEventType(agentId, "tool.result"), { content: result.content ?? result, token_usage: result.token_usage ?? null }, `TOOL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
          if (tool.kind === "request_info") {
            const taskSummary = message.payload.task ? `${message.payload.task.title}: ${message.payload.task.objective}` : message.payload.text;
            const stateSummary = `Task ${taskId}: ${taskSummary}; context request completed; return submit_code when ready.`;
            const contextRef = `CTX-${taskId}-${round}-${createHash("sha256").update(String(result.content ?? "")).digest("hex").slice(0, 12)}`;
            const contextContent = String(result.content ?? "");
            contextRefs.set(contextRef, contextContent);
            const excerpt = contextContent.slice(0, 3000);
            requestPayload = { text: `task_id: ${taskId}\ncontext_ref: ${contextRef}\nstate_summary: ${stateSummary}\ncontext_status: ${result.status ?? "context_ready"}\ncontext_available: ${result.context_available !== false}\ntool_result: context stored by Node (${contextContent.length} chars)\ncontext_excerpt:\n${excerpt}\nnext_step: submit_code\n\nUse the context_ref for correlation. Return submit_code now.` };
            requestedNextRound = true;
          }
          if (tool.kind === "submit_code") {
            emitProgress(message, agentId, "Code received; completing…", `PROGRESS-${round}-SUBMIT`);
            submittedCode = true;
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
      persistProtocolMessage({ ...message, payload: { ...message.payload, text } }, message.payload.round ?? 1, "response");
      await onAgentCompleted?.({ message, agentId, text });
    } catch (error) {
      bus.send(responseMessage(message, streamEventType(agentId, "error"), { error: error.message, agent_status: "FAILED" }, "ERROR"));
    }
  }

  // Emits a non-persisted progress signal for the active agent turn.
  function emitProgress(message, agentId, text, suffix) {
    debug({ event: "agent.loop.progress", agent_id: agentId, conversation_id: message.conversation_id, text });
    bus.sendFast(responseMessage(message, streamEventType(agentId, "message.progress"), { text, progress: true }, suffix));
  }

    // Identifies duplicate context requests within one agent turn.
  function requestInfoFingerprint(tool) { return JSON.stringify({ tool: tool.tool, target_path: tool.target_path ?? null, query: tool.query ?? null }); }

  // Persists a protocol envelope when protocol storage is configured.
  function persistProtocolMessage(message, round, direction) {
    if (!protocolStorage?.save || !message?.conversation_id) return;
    const taskId = message.payload?.task?.id ?? message.payload?.ticket?.id ?? message.id.replace(/[^A-Za-z0-9._-]/g, "-");
    const ref = `task/${taskId}/round_${round}/${direction}`;
    Promise.resolve(protocolStorage.save(ref, message, { schemaId: direction === "request" ? "forge-envelope" : "forge-response" }))
      .catch((error) => debug({ event: "protocol-storage.persist.error", ref, error: error.message }));
  }

}

// Validates a tool request against the agent protocol schema.
function validateAgentTool(value) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return Boolean(ajv.compile(agentToolSchema)(value));
}

// Formats agent-specific event names for the conversation stream.
function streamEventType(agentId, suffix) { return agentId === "architecture-manager" ? `architecture.${suffix}` : `${agentId}.${suffix}`; }

// Summarizes an agent payload for debug logging.
function summarizePayload(payload) {
  const text = String(payload?.text ?? "");
  return { chars: text.length, sha256: createHash("sha256").update(text).digest("hex"), preview: redactPreview(text, 2000), has_tools: Array.isArray(payload?.tools) && payload.tools.length > 0 };
}

// Summarizes a tool value for debug logging.
function summarizeValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { chars: text.length, preview: redactPreview(text, 2000) };
}

// Redacts sensitive values from a text preview.
function redactPreview(value, limit = 500) {
  return String(value ?? "").replace(/(?:api[_-]?key|credential|secret|password|token|authorization)\s*[:=]\s*[^\s,}]+/gi, "$1=[REDACTED]").slice(0, limit);
}
