// Drafts a governance ticket through the sprint leader over the Claude SDK.
//
// The leader searches the codebase itself with built-in Read/Grep/Glob tools,
// so candidate file paths are verified against disk instead of hallucinated.
// Forge MCP tools are never attached here: ticket drafting needs search only.
import { extractTicketJson } from "./ticket-draft-parser.js";

const BUILTIN_SEARCH_TOOLS = Object.freeze(["Read", "Grep", "Glob"]);

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
      return extractTicketJson(collectText(result?.messages));
    } catch (error) {
      logger.error?.("Sprint leader ticket draft failed.", { error: error.message });
      throw error;
    }
  }
}

// Builds the drafting instruction with built-in search directions.
function buildPrompt({ projectId, content, ticket, feedback }) {
  return [
    "Convert the project owner request below into exactly one governance ticket.",
    "Write ALL ticket field values (title, objective, acceptance_criteria) in English. If the owner request is in another language (e.g. Vietnamese), translate it into clear technical English.",
    "REQUIRED: Infer ticket style as a non-empty array of strings. Valid values: frontend (UI/component/page/accordion/modal/chat UI), backend (api/endpoint/database/server), security (auth/permission/credential), infra (deploy/docker/pipeline), docs (documentation). Every ticket MUST include style with at least one value; return e.g. [\"frontend\"] or [\"frontend\",\"backend\"]. Do NOT omit style.",
    "You have codebase access through built-in tools only: use Glob/Grep to find related files and Read to verify them before citing. Do NOT use any Forge MCP tools (no search_code, read_code, select_code_graph_candidates) — built-in tools are enough for this task.",
    "REQUIRED: candidate_files (array of {path, role, symbol, reason}, 3-8 entries) with real paths you verified with Read. Assign each file exactly one role: PATCH (must be edited to complete the ticket — symbol is REQUIRED: the exact function/component/route name to edit, no line numbers), REUSE (already provides what the ticket needs — symbol is REQUIRED: the exact function name, no edit, no line numbers), REFERENCE (useful pattern only, not this ticket's target), IGNORE (looks related but is not — state why). Line numbers go stale after other tickets edit the same file, so never use them as addresses; the symbol name is the address. A file over the p90 size threshold (lines >= 246) with only repeated generic-token matches is a hub suspect: verify by reading before assigning PATCH. A response without candidate_files, or with a PATCH/REUSE entry missing symbol, is rejected.",
    "Respond with ONLY one ```json fenced block containing the ticket JSON object. No prose outside the block.",
    "Ticket fields: title (string, required), objective (string, required), acceptance_criteria (array of strings, at least one, required), style (array of strings, REQUIRED, at least one: frontend|backend|security|infra|docs), candidate_files (array of {path, role, symbol, reason}, REQUIRED, 3-8 entries verified via built-in search; symbol REQUIRED for PATCH/REUSE), priority (optional: low|medium|normal|high|critical), dependencies (optional: array of ticket ids).",
    "Do NOT include id, project_id, roadmap_id, sprint_id, status, last_error, or provenance; the system assigns them.",
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
