// Drafts a governance ticket through the sprint leader over the Claude SDK.
//
// The leader drafts scope and acceptance criteria without assigning source-file candidates.
import { extractTicketJson } from "./ticket-draft-parser.js";

const BUILTIN_SEARCH_TOOLS = Object.freeze([]);

// Creates a runner that asks the sprint leader for one ticket draft with codebase search.
export function createTicketSprintLeader({ sdkGateway, projectRoot, logger = console } = {}) {
  return Object.freeze({ requestTicket });

  // Asks the leader to draft one ticket, letting it search the codebase first.
  async function requestTicket({ projectId, agentId, content, ticket, feedback, correlationId }) {
    if (typeof sdkGateway?.execute !== "function") throw new Error("Ticket sprint leader requires an SDK gateway.");
    const prompt = buildPrompt({ projectId, content, ticket, feedback });
    try {
      const result = await sdkGateway.execute({
        agentId,
        prompt,
        correlationId,
        cwd: projectRoot ?? process.cwd(),
        options: { allowedTools: [...BUILTIN_SEARCH_TOOLS] }
      });
      const messages = result?.messages;
      const output = typeof result?.text === "string" ? result.text : collectText(messages);
      const draft = extractTicketJson(output);
      if (!draft) {
        logger.error?.("SPRINT_LEADER_TICKET_PARSE_FAILED", {
          agent_id: agentId,
          correlation_id: correlationId,
          ...(ticket?.id ? { ticket_id: ticket.id } : {}),
          task_id: ticket?.id ?? `PROJECT-${projectId}`,
          ...(result?._gateway_diagnostics ?? {}),
          prompt_chars: prompt.length,
          response_fields: result && typeof result === "object" ? Object.keys(result).filter((key) => !/(?:api[_-]?key|credential|secret|password|token|authorization)/i.test(key)) : [],
          result_text_chars: typeof result?.text === "string" ? result.text.length : null,
          message_count: Array.isArray(messages) ? messages.length : messages ? 1 : 0,
          output_chars: output.length,
          message_summary: summarizeMessages(messages),
          output_preview: redactOutputPreview(output, content)
        });
      }
      return draft;
    } catch (error) {
      logger.error?.("Sprint leader ticket draft failed.", {
        agent_id: agentId,
        correlation_id: correlationId,
        ...(ticket?.id ? { ticket_id: ticket.id } : {}),
        task_id: ticket?.id ?? `PROJECT-${projectId}`,
        ...(error.gatewayDiagnostics ?? {}),
        prompt_chars: prompt.length,
        error: error.message
      });
      throw error;
    }
  }
}

// Builds the ticket drafting instruction without file-candidate discovery.
function buildPrompt({ projectId, content, ticket, feedback }) {
  return [
    "Convert the project owner request below into exactly one governance ticket.",
    "Write ALL ticket field values (title, objective, acceptance_criteria) in English. If the owner request is in another language (e.g. Vietnamese), translate it into clear technical English.",
    "REQUIRED: Infer ticket style as a non-empty array of strings. Valid values: frontend (UI/component/page/accordion/modal/chat UI), backend (api/endpoint/database/server), security (auth/permission/credential), infra (deploy/docker/pipeline), docs (documentation). Every ticket MUST include style with at least one value; return e.g. [\"frontend\"] or [\"frontend\",\"backend\"]. Do NOT omit style.",
    "Draft only the ticket's objective, acceptance criteria, style, priority, and dependencies. Do not identify source files or symbols; implementation discovery belongs to the Coder.",
    "Respond with ONLY one ```json fenced block containing the ticket JSON object. No prose outside the block.",
    "Ticket fields: title (string, required), objective (string, required), acceptance_criteria (array of strings, at least one, required), style (array of strings, REQUIRED, at least one: frontend|backend|security|infra|docs), priority (optional: low|medium|normal|high|critical), dependencies (optional: array of ticket ids).",
    "Do NOT include candidate_files, candidates_produced_by, candidates_produced_at, id, project_id, roadmap_id, sprint_id, status, last_error, or provenance; the system assigns identity fields.",
    feedback ? `Previous validation feedback: ${feedback}` : undefined,
    `Project id: ${projectId}`,
    content ? `Owner request (raw chat):\n${content}` : undefined,
    ticket ? `Owner draft ticket JSON that failed validation:\n${JSON.stringify(ticket, null, 2)}` : undefined
  ].filter((line) => line !== undefined).join("\n\n");
}

// Collects text parts from SDK messages into one searchable string.
function collectText(messages) {
  if (typeof messages === "string") return messages;
  if (Array.isArray(messages)) return messages.map(collectText).join("\n");
  if (!messages || typeof messages !== "object") return "";
  if (typeof messages.text === "string") return messages.text;
  return ["message", "content", "output"].map((key) => collectText(messages[key])).join("\n");
}

// Summarizes SDK message structure without recording message text or prompt content.
function summarizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-10).map((message) => ({
    type: typeof message?.type === "string" ? message.type : "unknown",
    ...(typeof message?.role === "string" ? { role: message.role } : {}),
    ...(typeof message?.message?.stop_reason === "string" ? { stop_reason: message.message.stop_reason } : {}),
    content_types: Array.isArray(message?.message?.content)
      ? message.message.content.map((part) => typeof part?.type === "string" ? part.type : "unknown")
      : [],
    text_lengths: Array.isArray(message?.message?.content)
      ? message.message.content.filter((part) => typeof part?.text === "string").map((part) => part.text.length)
      : []
  }));
}

// Redacts sensitive values and the owner's submitted context before logging output.
function redactOutputPreview(value, content) {
  const lines = String(value ?? "").split("\n").map((line) => {
    let previewLine = line;
    if (typeof content === "string" && content) previewLine = previewLine.split(content).join("[OWNER_CONTEXT]");
    return previewLine.replace(/(?:api[_-]?key|credential|secret|password|token|authorization)\s*[:=]\s*[^\s,}]+/gi, "[REDACTED]");
  });
  return lines.join("\n").slice(0, 500);
}
