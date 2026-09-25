// Drafts a governance sprint plan through the sprint leader over the Claude SDK.
//
// The leader searches the codebase itself with built-in Read/Grep/Glob tools,
// so candidate file paths are verified against disk instead of hallucinated.
// Forge MCP tools are never attached here: plan drafting needs search only.
import { extractTicketJson } from "./ticket-draft-parser.js";

const BUILTIN_SEARCH_TOOLS = Object.freeze(["Read", "Grep", "Glob"]);

// Creates a runner that asks the sprint leader for one sprint plan with codebase search.
export function createSprintPlanLeader({ sdkGateway, projectRoot, logger = console } = {}) {
  return Object.freeze({ requestPlan });

  // Asks the leader to draft one sprint plan, letting it search the codebase first.
  async function requestPlan({ projectId, agentId, brief, feedback, correlationId }) {
    if (typeof sdkGateway?.execute !== "function") throw new Error("Sprint plan leader requires an SDK gateway.");
    const prompt = buildPlanPrompt({ projectId, brief, feedback });
    try {
      const result = await sdkGateway.execute({
        agentId,
        prompt,
        correlationId,
        cwd: projectRoot ?? process.cwd(),
        options: { allowedTools: [...BUILTIN_SEARCH_TOOLS] }
      });
      return extractTicketJson(typeof result?.text === "string" ? result.text : collectText(result?.messages));
    } catch (error) {
      logger.error?.("Sprint leader plan draft failed.", { error: error.message });
      throw error;
    }
  }
}

// Builds the plan drafting instruction with built-in search directions.
function buildPlanPrompt({ projectId, brief, feedback }) {
  return [
    "Draft exactly one governance sprint plan for the sprint brief below.",
    "Write ALL field values (objective, titles, acceptance_criteria) in English. If the brief is in another language (e.g. Vietnamese), translate it into clear technical English.",
    "You have codebase access through built-in tools only: use Glob/Grep to find related files and Read to verify them before citing. Do NOT use any Forge MCP tools (no search_code, read_code, select_code_graph_candidates) — built-in tools are enough for this task.",
    "REQUIRED: every ticket MUST include style (array, at least one: frontend|backend|security|infra|docs) and candidate_files (array of {path, role, symbol, reason}, 3-8 entries) with real paths you verified with Read. Assign each file exactly one role: PATCH (must be edited — symbol is REQUIRED: the exact function/component/route name to edit, no line numbers), REUSE (already provides what the ticket needs — symbol is REQUIRED: the exact function name, no edit, no line numbers), REFERENCE (useful pattern only), IGNORE (looks related but is not — state why). Line numbers go stale after other tickets edit the same file, so never use them as addresses; the symbol name is the address. A response with a ticket missing candidate_files, or with a PATCH/REUSE entry missing symbol, is rejected.",
    "Respond with ONLY one ```json fenced block containing the sprint plan JSON object. No prose outside the block.",
    "Plan fields: id (string, REQUIRED — use the sprint id given below), roadmap_id (REQUIRED — use the roadmap id given below), project_id (REQUIRED — use the project id given below), objective (string, required), tickets (array, at least one; each ticket: title, objective, acceptance_criteria (at least one), style, candidate_files, optional priority/dependencies), exit_criteria (array of strings, at least one).",
    "Do NOT include ticket id, project_id, roadmap_id, sprint_id, status, last_error, or provenance on tickets; the system assigns them.",
    feedback ? `Previous validation feedback: ${feedback}` : undefined,
    `Project id: ${projectId}`,
    brief ? `Sprint brief:\n${brief}` : undefined
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
