/** Defines the same typed, nonterminal work status for Claude and Codex. Node
 * validates routing and preserves the existing assignment; progress never
 * replaces report_done, verification, review, or a governed blocker report. */
import { assertAgentExchangePayload, bindAgentExchangeResponse } from "../../governance/agent-exchange.js";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { activeFileChecksums } from "./ticket-read-cache.js";
import { formatMidFlightDirectives } from "./ticket-directive-inbox.js";

const require = createRequire(import.meta.url);
const schemaPath = existsSync(new URL("../../../../../.forge/schemas/governance/agent-exchange-payload.schema.json", import.meta.url))
  ? "../../../../../.forge/schemas/governance/agent-exchange-payload.schema.json"
  : "../../../../../schemas/governance/agent-exchange-payload.schema.json";
const progressSchema = require(schemaPath).$defs.work_progress;

/** Supplies both SDK providers with the exact shared schema and a short example
 * so yielding a phase does not accidentally terminate the ticket assignment. */
export const TICKET_WORK_PROGRESS_PROMPT = `SDK turn completion is not ticket completion. Continue using the authorized tools until report_done succeeds, or report_done(status=blocked) records a real blocker. If you must end an SDK turn between phases, return ONLY this shared Agent Exchange v1 work_progress JSON, with no surrounding prose:
{"kind":"work_progress","subject":"Discovery complete","payload":{"status":"discovery_complete","next_action":"implement","summary":"Relevant source and constraints identified.","remaining_work":["Implement the approved ticket from the retained checkpoint."]},"evidence":[]}
Use status/next_action pairs discovery_complete/implement, implementation_complete/verify, or verification_complete/report. These are nonterminal progress messages, not approval or completion. Node continues the SAME SDK session and checkpoint automatically; do not wait for another user message or restart discovery. Never claim completion in prose instead of invoking report_done. For access, policy or scope blockers use the existing report_done(status=blocked) schema, not work_progress. Do not invent session, execution, agent, message or checkpoint identities.
Exact work_progress payload JSON Schema: ${JSON.stringify(progressSchema)}`;

/** Parses exact JSON status rather than classifying the wording of a narrative
 * answer. Legacy prose receives a schema correction in the existing session. */
export function parseTicketWorkProgress(text, assignment) {
  if (typeof text !== "string" || text.length > 12000) throw new Error("Return one bounded work_progress JSON object.");
  const content = JSON.parse(text.trim().replace(/^```json\s*\n([\s\S]*?)\n```$/i, "$1"));
  if (!content || content.kind !== "work_progress" || typeof content.subject !== "string" || !content.subject.trim() || content.subject.length > 500
    || !Array.isArray(content.evidence) || content.evidence.length || Object.keys(content).some((key) => !["kind", "subject", "payload", "evidence"].includes(key)))
    throw new Error("Return only kind=work_progress, subject, payload and evidence=[].");
  assertAgentExchangePayload("work_progress", content.payload);
  return assignment ? bindAgentExchangeResponse(content, assignment) : content;
}

/** Gives the resumed session only its validated next phase and compact tool
 * checkpoint. Schema corrections cannot reset discovery or grant permissions. */
export function ticketWorkContinuationPrompt(progress, state = {}, directives = []) {
  const correction = progress ? `Node accepted work_progress: ${JSON.stringify(progress.payload)}.` : "The last SDK turn did not include a valid work_progress response. Use the required schema if you yield again; do not replace a tool action with a narrative promise.";
  const checksums = activeFileChecksums(state.readCache);
  const checksumLine = Object.keys(checksums).length
    ? `\nActive file checksums (reuse as before_checksum for edit_diff/write_diff/delete_file/move_file without re-reading unchanged windows): ${JSON.stringify(checksums)}.`
    : "";
  const directiveBlock = formatMidFlightDirectives(directives?.length ? directives : state.deliveredDirectives);
  return `${correction}\nContinue the SAME assignment, provider session and checkpoint at tool turn ${state.turnCount ?? 0}. Completed tool names: ${JSON.stringify((state.completedTools ?? []).slice(-8))}.${checksumLine}${directiveBlock ? `\n${directiveBlock}` : ""} Preserve all existing changes, decisions and tool receipts. Execute the next authorized step now; do not restart discovery, repeat completed edits or wait for another user message. A phase status never bypasses tool authorization, commit, verification or report_done.\n${TICKET_WORK_PROGRESS_PROMPT}`;
}
