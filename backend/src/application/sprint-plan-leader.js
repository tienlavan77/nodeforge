// Drafts a governance sprint plan through the configured Sprint Leader SDK.
//
// The leader plans work without assigning source-file candidates to tickets.
import { extractTicketJson } from "./ticket-draft-parser.js";

// Creates a runner that asks the sprint leader for one sprint plan with codebase search.
export function createSprintPlanLeader({ sdkGateway, projectRoot, toolOptions, logger = console } = {}) {
  return Object.freeze({ requestPlan });

  // Asks the leader to draft one sprint plan, letting it search the codebase first.
  async function requestPlan({ projectId, agentId, brief, feedback, correlationId }) {
    if (typeof sdkGateway?.execute !== "function") throw new Error("Sprint plan leader requires an SDK gateway.");
    const prompt = buildPlanPrompt({ projectId, brief, feedback });
    try {
      const options = toolOptions ? toolOptions({ agentId, correlationId }) : { tools: [] };
      const result = await sdkGateway.execute({
        agentId,
        prompt,
        correlationId,
        cwd: projectRoot ?? process.cwd(),
        options
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
    "Use the supplied read-only Forge search_tree, search_code, and read_file tools to verify relevant project structure and cite observed evidence. read_file accepts offset and limit for bounded source windows. Do not use built-in shell, file, network, or write tools.",
    "Write ALL field values (objective, titles, acceptance_criteria) in English. If the brief is in another language (e.g. Vietnamese), translate it into clear technical English.",
    "Every ticket MUST include implementation_type as a one-item array: frontend|backend|security. Do not return the legacy style field. Do not identify source files or symbols; implementation discovery belongs to the Coder.",
    "Respond with ONLY one ```json fenced block containing the sprint plan JSON object. No prose outside the block.",
    "Plan fields: id (sprint id), roadmap_id, project_id, objective, tickets (each with title, objective, acceptance_criteria, exactly one implementation_type, file_budget set to 4 or less, optional priority/dependencies/change_nature), exit_criteria, and human_plan.",
    "human_plan MUST contain outcome, in_scope, out_of_scope, approach, components (specific affected components), risks, assumptions, open_questions, evidence_refs, and acceptance_criteria. in_scope, out_of_scope and approach may be a nonempty string or an array of nonempty strings. Provide concrete reviewable statements and at least one evidence reference. Cite only facts in the sprint brief or context actually inspected; never invent files or architecture decisions. State unknowns in open_questions.",
    "Create a unique stable TICKET-* id for every ticket. Dependencies must refer only to ticket IDs in this Sprint Plan. Do NOT include candidate_files, candidates_produced_by, candidates_produced_at, ticket project_id, roadmap_id, sprint_id, status, last_error, or provenance; Node assigns parent and provenance fields.",
    "For an approved Markdown brief, preserve the exact number and order of work groups in section 5. Copy each work group's English title, objective, and semicolon-separated acceptance criteria into its corresponding ticket without rewriting them. Convert dependency labels to generated ticket IDs, keep the implementation type, and do not exceed the approved mutable-file budget.",
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
