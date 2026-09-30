// Drafts a governance sprint plan through the sprint leader over the Claude SDK.
//
// The leader plans work without assigning source-file candidates to tickets.
import { extractTicketJson } from "./ticket-draft-parser.js";

const BUILTIN_SEARCH_TOOLS = Object.freeze([]);

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

// Builds the sprint planning instruction without file-candidate discovery.
function buildPlanPrompt({ projectId, brief, feedback }) {
  return [
    "Draft exactly one governance sprint plan for the sprint brief below.",
    "Write ALL field values (objective, titles, acceptance_criteria) in English. If the brief is in another language (e.g. Vietnamese), translate it into clear technical English.",
    "Every ticket MUST include style (array, at least one: frontend|backend|security|infra|docs). Do not identify source files or symbols; implementation discovery belongs to the Coder.",
    "Respond with ONLY one ```json fenced block containing the sprint plan JSON object. No prose outside the block.",
    "Plan fields: id (string, REQUIRED — use the sprint id given below), roadmap_id (REQUIRED — use the roadmap id given below), project_id (REQUIRED — use the project id given below), objective (string, required), tickets (array, at least one; each ticket: title, objective, acceptance_criteria (at least one), style, optional priority/dependencies), exit_criteria (array of strings, at least one).",
    "Do NOT include candidate_files, candidates_produced_by, candidates_produced_at, ticket id, project_id, roadmap_id, sprint_id, status, last_error, or provenance on tickets; the system assigns identity fields.",
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
