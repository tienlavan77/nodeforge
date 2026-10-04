// Drafts a governance sprint plan through the configured Sprint Leader SDK.
import { extractTicketJson } from "./ticket-draft-parser.js";
import { startSprintLeaderProgress } from "./sprint-leader-progress.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const RULES_PATH = "workflows/agents/sprint-leader/README.md";

// Creates a runner that asks the sprint leader for one sprint plan with codebase search.
export function createSprintPlanLeader({ sdkGateway, projectRoot, toolOptions, logger = { error: console.error } } = {}) {
  return Object.freeze({ requestPlan });

  // Asks the leader to draft one sprint plan, letting it search the codebase first.
  async function requestPlan({ projectId, agentId, brief, feedback, correlationId }) {
    if (typeof sdkGateway?.execute !== "function") throw new Error("Sprint plan leader requires an SDK gateway.");
    const rules = await readFile(join(projectRoot ?? process.cwd(), RULES_PATH), "utf8");
    const prompt = buildPlanPrompt({ projectId, brief, feedback, rules });
    const discoveredPaths = new Set();
    const stopProgress = startSprintLeaderProgress({ logger, kind: "sprint_plan", agentId, correlationId });
    try {
      const options = toolOptions ? toolOptions({ agentId, correlationId, discoveredPaths }) : { tools: [] };
      const result = await sdkGateway.execute({
        agentId,
        prompt,
        correlationId,
        cwd: projectRoot ?? process.cwd(),
        options
      });
      const plan = extractTicketJson(typeof result?.text === "string" ? result.text : collectText(result?.messages));
      const draft = stripLegacyCandidateFields(plan);
      stopProgress(draft ? "success" : "failed", { plan_id: draft?.id ?? null, ticket_count: draft?.tickets?.length ?? 0, discovered_paths: discoveredPaths.size });
      return draft;
    } catch (error) {
      stopProgress("failed");
      logger.error?.("Sprint leader plan draft failed.", { error: error.message });
      throw error;
    }
  }
}

// Removes obsolete file candidate metadata so the Coder owns implementation discovery.
function stripLegacyCandidateFields(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.tickets)) return plan;
  return {
    ...plan,
    tickets: plan.tickets.map((ticket) => {
      const clean = { ...(ticket ?? {}) };
      delete clean.candidate_files;
      delete clean.candidates_produced_by;
      delete clean.candidates_produced_at;
      return clean;
    })
  };
}

// Builds the sprint planning instruction with optional evidence-backed file references.
function buildPlanPrompt({ projectId, brief, feedback, rules }) {
  return [
    "Draft exactly one governance sprint plan for the sprint brief below.",
    `Read and follow the Sprint Leader role rules from ${RULES_PATH} below. The current approved Markdown scope and implementation_type schema take precedence over older terminology in this role file.\n\n${rules}`,
    "Investigate the project with the supplied read-only Forge search_tree, search_code, and read_file tools before drafting tickets. Search for relevant components and, when possible, identify existing related files. read_file accepts offset and limit for bounded source windows. Cite actual observations; if discovery is unavailable, state the uncertainty. Do not use built-in shell, file, network, or write tools.",
    "Write ALL field values (objective, titles, acceptance_criteria) in English. If the brief is in another language (e.g. Vietnamese), translate it into clear technical English.",
    "Every ticket MUST include implementation_type as a one-item array: frontend|backend|security. Do not return the legacy style field. File references are discovery hints, not an immutable edit manifest; the Coder verifies actual change scope.",
    "Respond with ONLY one ```json fenced block containing the sprint plan JSON object. No prose outside the block.",
    "Plan fields: id (sprint id), roadmap_id, project_id, objective, tickets (each with title, objective, acceptance_criteria, exactly one implementation_type, file_budget set to 4 or less, optional priority/dependencies/change_nature/outcome_refs), exit_criteria, and human_plan. If included, change_nature must be presentation-only for visual frontend changes or test-only for test-only work; omit it otherwise.",
    "human_plan MUST contain outcome, in_scope, out_of_scope, approach, components (specific affected components), risks, assumptions, open_questions, evidence_refs, and acceptance_criteria. in_scope, out_of_scope and approach may be a nonempty string or an array of nonempty strings. evidence_refs MUST be an array of nonempty strings, not objects. Provide concrete reviewable statements and at least one evidence reference. Cite only facts in the sprint brief or context actually inspected; never invent files or architecture decisions. State unknowns in open_questions.",
    "Create a unique stable TICKET-* id for every ticket. Dependencies must refer only to ticket IDs in this Sprint Plan. Do not include candidate_files or candidate metadata; the Coder discovers implementation paths. Do not include ticket project_id, roadmap_id, sprint_id, status, last_error, or provenance; Node assigns provenance fields.",
    "If approved Markdown Section 5 contains numbered work groups, return one ticket per work group in order; Node binds the approved ticket scope. If Section 5 contains O1/O2 outcome rows, independently split or combine work into scoped tickets and include outcome_refs with approved outcome IDs on every ticket. Cover every outcome and its acceptance criteria without weakening them; preserve guardrails and real dependencies. Node checks explicit outcome coverage and human review checks semantic coverage. Do not add file candidates; the Coder discovers implementation paths. Do not reinterpret the approved business scope.",
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
