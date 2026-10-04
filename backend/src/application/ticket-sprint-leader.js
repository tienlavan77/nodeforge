// Drafts a governance ticket through the configured Sprint Leader SDK.
import { extractTicketJson } from "./ticket-draft-parser.js";
import { startSprintLeaderProgress } from "./sprint-leader-progress.js";

// Creates a runner that asks the sprint leader for one ticket draft with codebase search.
export function createTicketSprintLeader({ sdkGateway, projectRoot, toolOptions, logger = { error: console.error } } = {}) {
  return Object.freeze({ requestTicket });

  // Asks the leader to draft one ticket, letting it search the codebase first.
  async function requestTicket({ projectId, agentId, content, ticket, feedback, correlationId }) {
    if (typeof sdkGateway?.execute !== "function") throw new Error("Ticket sprint leader requires an SDK gateway.");
    const prompt = buildPrompt({ projectId, content, ticket, feedback });
    const discoveredPaths = new Set();
    const stopProgress = startSprintLeaderProgress({ logger, kind: "ticket", agentId, correlationId });
    try {
      const options = toolOptions ? toolOptions({ agentId, correlationId, discoveredPaths }) : { tools: [] };
      const result = await sdkGateway.execute({
        agentId,
        prompt,
        correlationId,
        cwd: projectRoot ?? process.cwd(),
        options
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
      stopProgress(draft ? "success" : "failed", { ticket_id: draft?.id ?? ticket?.id ?? null, parsed: Boolean(draft), discovered_paths: discoveredPaths.size });
      return stripLegacyCandidateFields(draft);
    } catch (error) {
      stopProgress("failed");
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

// Removes obsolete file candidate metadata so the Coder owns implementation discovery.
function stripLegacyCandidateFields(ticket) {
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) return ticket;
  const clean = { ...ticket };
  delete clean.candidate_files;
  delete clean.candidates_produced_by;
  delete clean.candidates_produced_at;
  return clean;
}

// Builds the ticket drafting instruction with optional observed file references.
function buildPrompt({ projectId, content, ticket, feedback }) {
  return [
    "Convert the project owner request below into exactly one governance ticket.",
    "Investigate the project with the supplied read-only Forge search_tree, search_code, and read_file tools before drafting the ticket. Find related existing files when possible and cite only observed facts. If discovery is unavailable, state the uncertainty. Do not use built-in shell, file, network, or write tools.",
    "Write ALL ticket field values (title, objective, acceptance_criteria) in English. If the owner request is in another language (e.g. Vietnamese), translate it into clear technical English.",
    "REQUIRED: Set implementation_type to exactly one value in a one-item array: frontend (UI/component/page/chat UI), backend (API/database/server), or security (auth/permission/credential). Return e.g. [\"frontend\"]. Do not return the legacy style field or combine types.",
    "Draft the ticket's objective, acceptance criteria, implementation_type, priority, and dependencies. Optionally set change_nature to presentation-only for a visual-only frontend ticket or test-only for test-only work. File references are discovery hints; the Coder verifies actual edit scope.",
    "Respond with ONLY one ```json fenced block containing the ticket JSON object. No prose outside the block.",
    "Ticket fields: title (string, required), objective (string, required), acceptance_criteria (array of strings, at least one, required), implementation_type (exactly one array value: frontend|backend|security), file_budget (integer 1-4, required), priority (optional: low|medium|normal|high|critical), dependencies (optional: array of ticket ids), change_nature (optional: presentation-only|test-only).",
    "Do not include candidate_files or candidate metadata; the Coder discovers implementation paths. Do not include id, project_id, roadmap_id, sprint_id, status, last_error, or provenance; Node assigns identity and provenance fields.",
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
