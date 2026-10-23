// Drafts a governance sprint plan through the configured Sprint Leader SDK.
import { SPRINT_LEADER_WEB_SEARCH_PROMPT } from "../tools/sprint-leader-web-search.js";
import { extractTicketJson } from "./ticket-draft-parser.js";
import { PLANNING_AUTONOMY_PROMPT } from "../shared/implementation-autonomy.js";
import { startSprintLeaderProgress } from "./sprint-leader-progress.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { invalidSprintTicketPriorities, repairSprintTicketPriorities, TICKET_PRIORITY_VALUES } from "../modules/governance/sprint-ticket-priority.js";
import { normalizeSprintVerificationNotes, SPRINT_VERIFICATION_STEP_FIELDS } from "../modules/governance/sprint-verification-notes.js";

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
      let draft = normalizeSprintVerificationNotes(stripLegacyCandidateFields(plan));
      if (invalidSprintTicketPriorities(draft).length) {
        const repaired = await sdkGateway.execute({ agentId, correlationId: `${correlationId}-PRIORITY-REPAIR`, cwd: projectRoot ?? process.cwd(), options,
          prompt: `${prompt}\n\nPriority-only repair of the frozen Sprint draft below. Change ONLY invalid ticket priority fields to string values ${TICKET_PRIORITY_VALUES.join("|")}. Numeric priorities have no defined mapping: select the appropriate priority from the approved scope yourself. Preserve all Sprint/ticket IDs, ticket order, acceptance criteria, verification plans, dependencies, file budgets and every other field exactly. Return the full JSON draft. This is the only automatic repair attempt.\n${JSON.stringify(draft)}` });
        draft = repairSprintTicketPriorities(draft, extractTicketJson(typeof repaired?.text === "string" ? repaired.text : collectText(repaired?.messages)));
      }
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
    PLANNING_AUTONOMY_PROMPT,
    "Review-cycle policy: there is no fixed limit on Coder revision/Reviewer cycles. Never introduce a numeric review-cycle cap, max_review_revisions, or an exhausted-revisions stop rule into Sprint plans or tickets. Older repository documents prescribing such caps are superseded by this current policy. Continue from retained checkpoints until required findings are resolved and independent review and verification pass; escalate concrete scope, authority, access, or evidenced lack of progress, not the review count. Operational timeouts and provider retry scheduling belong to Node and do not impose a review-cycle cap.",
    `Read and follow the Sprint Leader role rules from ${RULES_PATH} below. The current approved Markdown scope and implementation_type schema take precedence over older terminology in this role file.\n\n${rules}`,
    "Investigate the project with the supplied read-only Forge search_tree, list_files, search_text, read_file, and read_lines tools before drafting tickets. Search for relevant components and, when possible, identify existing related files. read_file accepts offset and limit for bounded source windows; limit MUST be an integer from 1 through 250. Cite actual observations; if discovery is unavailable, state the uncertainty. Do not use built-in shell, file, or write tools.",
    SPRINT_LEADER_WEB_SEARCH_PROMPT,
    "Write newly authored prose in English. Approved acceptance criteria and coverage references MUST retain their exact original wording and language, including Vietnamese; never replace them with translations. During verification repair, preserve the supplied frozen draft and acceptance_criteria order exactly and change ONLY verification_plan. Number AC IDs against that final unchanged array.",
    "Every ticket MUST include implementation_type as a one-item array: frontend|backend|security. Do not return the legacy style field. File references are discovery hints, not an immutable edit manifest; the Coder verifies actual change scope.",
    `Ticket priority is optional; if included it MUST be one string from ${TICKET_PRIORITY_VALUES.join("|")}. Never use numeric ranks, numeric strings, P0/P1 labels, arrays, objects or null. Use ticket order and dependencies for sequencing, not numeric priority. During priority-only repair, change ONLY the rejected priority fields and preserve all other fields exactly.`,
    "Respond with ONLY one ```json fenced block containing the sprint plan JSON object. No prose outside the block.",
    "Plan fields: id (sprint id), roadmap_id, project_id, objective, tickets (each with title, objective, acceptance_criteria, verification_plan, exactly one implementation_type, a positive integer file_budget sized to the work; no global maximum, optional priority/dependencies/change_nature/outcome_refs), exit_criteria, and human_plan. If included, change_nature must be presentation-only for visual frontend changes or test-only for test-only work; omit it otherwise.",
    "For every new browser verification step, declare scenario_path pointing to a planned test module such as ui/nextjs/tests/feature.browser.mjs (or backend/tests/feature.browser.mjs). Coder implements this module in the ticket commit; Node executes it in Chromium for every approved assertion and viewport. The module exports createBrowserFixture({sourceRoot,build}) returning {html,assets}, and browserAssertions mapping each exact approved assertion to async ({page,viewport,origin}) => { /* real DOM/behavior assertions; throw on failure */ }. Bundle real project components; mock external I/O only. Do not assume free-form assertions are already implemented by Node. Include this module in the ticket file budget.",
    "Each ticket MUST include verification_plan. Give criteria stable positional IDs AC-1, AC-2, and so on. Every criterion must appear in at least one step: {criterion_ids:[\"AC-1\"],kind:\"test\",test_path:\"...\"} for an executable focused test; kind build|lint|typecheck|schema_validation|backend_tests for Node-owned checks; kind browser with nonempty string assertions and viewports as a nonempty array of unique positive integer widths in CSS pixels, e.g. viewports:[375,768,1440], for UI behavior. Do NOT use viewport objects, numeric strings, device names, width-by-height strings, decimals, zero or duplicate widths; kind governance or human only when no automated proof is appropriate. Do not claim a build proves a visual behavior. This plan is executed by Forge after commit and is shown unchanged to Coder.",
    `Verification step fields are strictly limited to: ${SPRINT_VERIFICATION_STEP_FIELDS.join(", ")}. Put explanatory prose in notes (a nonempty string), never description. Do not add command, expected_result or other extra fields. Notes do not replace required test_path, browser evidence or criterion coverage.`,
    "human_plan MUST contain outcome, in_scope, out_of_scope, approach, components, risks, assumptions, open_questions, evidence_refs, and acceptance_criteria. components MUST be an array of nonempty strings describing affected components, e.g. [\"backend API — validate plans\"], NEVER objects. risks, assumptions, open_questions, evidence_refs and acceptance_criteria MUST also be arrays of nonempty strings (risks, assumptions and open_questions may be empty). Do not include additional properties at the root or in human_plan; outcome_coverage is not a Sprint Plan schema field. For a components representation repair, change ONLY human_plan.components and preserve every ticket and all other fields exactly. in_scope, out_of_scope and approach may be a nonempty string or an array of nonempty strings. evidence_refs MUST be an array of nonempty strings, not objects. Provide concrete reviewable statements and at least one evidence reference. Cite only facts in the sprint brief or context actually inspected; never invent files or architecture decisions. State unknowns in open_questions.",
    "For outcome-based approved Markdown, every ticket MUST include outcome_refs and a coverage object for each referenced outcome. coverage[O#].criterion_refs MUST copy every approved acceptance criterion for that outcome verbatim, coverage[O#].guardrail_refs MUST copy every approved guardrail verbatim, and coverage[O#].dependency_refs MUST copy every mandatory dependency. Do not omit a guardrail because it is inconvenient; the Node admission gate checks all three lists.",
    "Owner policy decisions are recorded in the approved Architecture plan's Owner decisions section. Consume those exact policies when creating Sprint scope, tickets, dependencies and verification_plan. Do not create human_plan.decision_requests or ask the owner to select options again. Decide delegated implementation details yourself. For a criterion whose only prerequisite is an already recorded owner policy, use kind governance; implementation behavior still needs test/browser evidence. Do not defer policy choices with kind human or open_questions. If authority is genuinely unresolved or contradictory, report ARCHITECTURE_REPLAN_REQUIRED rather than invent approval, change the owner's decision or dispatch work.",
    "When approved scope requires reusing an existing management/public contract and forbids inventing one, set execution_policy.requires_existing_contract=true. Populate execution_policy.contract_evidence only from inspected source: [{path,sha256,authority_quote}], with a full-file SHA-256 and an exact approved-scope quote of at least 20 characters. If evidence is missing leave the array empty; Node routes discovery to SL/Architecture before Coder, not a blind implementation attempt. Never invent evidence or approval.",
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
