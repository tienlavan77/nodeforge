// Builds governed ticket and tool-lab prompts for Claude and Codex agents.
import { isBackendTicket } from "./nodeforge-task-scope.js";

export const COMPLEXITY_FALLBACK = Object.freeze({ effort: "medium", discovery_budget: 8, thinking: { type: "enabled", budgetTokens: 4096 } });

// Builds the Codex ticket instructions for governed implementation work.
export function buildCodexTicketPrompt(ticket, targetPath, allowedPrefixes, complexity, directCode = false, immutableScope = false) {
  const acceptance = (ticket?.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
  const allowedJson = JSON.stringify(allowedPrefixes);
  const backendRequired = isBackendTicket(ticket);
  const instructions = [
    `Discover the implementation from the ticket title, objective and acceptance criteria. Search and read relevant code within ${allowedJson}; choose the files yourself. No file is a mandatory target merely because it was found first.`,
    "Use search_code, rg_files and rg_search to find actual symbols and dependencies; inspect source before editing and add focused tests for the behavior you change.",
    ...(backendRequired ? ["If backend behavior is required, locate the relevant backend implementation and tests from the ticket rather than assuming a fixed route or service file."] : [])
  ];
  if (directCode) instructions.splice(0, 2, `This is a direct coding request. Do not use graph candidate retrieval. Discover with search_code or rg_files/rg_search inside approved prefixes ${allowedJson}; use read_file for metadata and symbol ranges, then sed_lines for source. You may read and edit schemas/, read workflows/ only, and must not access docs/.`);
  if (immutableScope) instructions.splice(0, 2, `This ticket has a signed immutable manifest. Work only on these exact paths ${allowedJson}; do not use prepass or candidate retrieval and do not infer a target_path. Read each relevant manifest file with read_file and sed_lines, then edit only manifest paths.`);
  return [
    `Complete the following ticket using Forge tools only; do not use built-in shell, file, patch, or search tools.`,
    "Before editing code, read workflows/agents/coder/README.md with sed_lines; this workflows path is read-only for coders.",
    "",
    `Ticket ${ticket?.id ?? ""}: ${ticket?.title ?? ""}`,
    `Objective: ${ticket?.objective ?? ""}`,
    ...(acceptance ? ["Acceptance criteria:", acceptance] : []),
    ...ticketVocabularyHints(ticket),
    "",
    ...instructions,
    "Hardening boundary: you may implement only hardening or fixes in the ticket's persisted scope and approved manifest. Do not rewrite boundaries already marked PASS in the acceptance report, weaken fail-closed gates, alias retired routes, or change governance authority.",
    "Production gate: the Coder cannot mark production accepted, release-ready, or done solely from implementation evidence. Preserve BLOCKED/NOT ACCEPTED FOR PRODUCTION until the required canary, terminal receipt, and release authority evidence exist.",
    ...coderProjectConventions("sed_lines"),
    "Work in English and produce all file content in English.",
    `Budget discipline: you have a hard wall-clock deadline and a discovery budget of ${complexity.discovery_budget} exploration calls. The next action after identifying the target and relevant context is edit_diff or write_diff; do not spend the full budget by default. Respect the discovery budget and start editing promptly. Productive discovery may receive one bounded extension. Re-read nothing you already read; prefer edit_diff with an exact anchor over re-reading whole files. Do not run run_test before at least one edit_diff/write_diff succeeded.`,
    immutableScope ? "Immutable-manifest search discipline: candidate retrieval is unavailable. Read and edit only approved manifest paths." : directCode ? "Direct-code search discipline: use search_code, rg_files and rg_search inside approved prefixes." : "Search discipline: use search_code for indexed file and symbol discovery, rg_files for paths, and rg_search for live text. Do not repeat a search that returned no matches without new evidence.",
    "Call read_file({path}) for cached metadata, current symbol start_line/end_line and scoped graph; it never returns source for coders. Read source with sed_lines({path,start_line,end_line}), at most 80 lines.",
    "Symbol check: if the ticket symbol is missing from the file or no longer matches the ticket reason, re-discover via rg_search instead of editing blind.",
    "Tool enforcement: sed_lines requires path, start_line, and end_line; read at most 80 lines per call and stay within the ticket scope.",
    "Use the whole-file sha256 returned by sed_lines as before_checksum for write_diff/edit_diff. Use JSON null only when creating a new file.",
    "For every acceptance criterion, include one acceptance_coverage entry using a stable criterion_id (AC-1, AC-2, etc.). Use status=verified only when the artifact contains a passing command; use status=evidence_pending for browser/visual or other evidence that Reviewer must inspect. Criterion wording need not be copied exactly.",
    `When the ticket is satisfied, call commit_changes with the exact changed file paths recorded during this execution, then run_test and poll check_test until passed, then call report_done with summary, acceptance_criteria, acceptance_coverage (one entry per criterion using stable criterion_id), implementation_scope (actual changed_files, not_changed_files, scope_rationale), and typed evidence. Do not call Reviewer tools or submit finding resolutions. If report_done says fields are missing or invalid, supplement only those fields for the same artifact. Stop after the complete report.`
  ].filter((line) => line !== undefined).join("\n");
}

// Builds the fixed Codex Forge tool-lab prompt.
export function buildCodexToolTestPrompt(taskId, targetPath) {
  return [
    "Run the fixed six-tool Forge MCP integration test. Do not inspect or use any ticket title, objective, description, or acceptance criteria.",
    "For this integration test, use Forge MCP tools only; do not use built-in shell, file, patch, or search tools. If Codex displays the server-qualified names (for example mcp__forge__rg_files), those are the same Forge tools and must be used.",
    "Call exactly these six Forge tools once each, in this order: rg_files, sed_lines, write_diff, run_test, commit_changes, report_done.",
    `Call rg_files with exactly: ${JSON.stringify({ flags: [] })}.`,
    `Call sed_lines with exactly: ${JSON.stringify({ path: targetPath, start_line: 1, end_line: 40 })}. If it succeeds, use its returned sha256 as before_checksum; if the target does not exist, use JSON null.`,
    `Call write_diff for exactly path ${JSON.stringify(targetPath)} with content exactly "tool-lab\\n" and before_checksum set to the exact checksum from sed_lines, or JSON null for a new target. Never send the string "null".`,
    "Call run_test with exactly {}.",
    `Call commit_changes with exactly: ${JSON.stringify({ message: `Codex Forge six-tool test ${taskId}`, paths: [targetPath] })}.`,
    "Call report_done with a concise summary of the six tool calls. Stop after report_done."
  ].join("\n");
}

// Keeps ticket-provided terminology available to the coding agent.
function ticketVocabularyHints(ticket = {}) {
  if (!Array.isArray(ticket.vocabulary_hints) || ticket.vocabulary_hints.length === 0) return [];
  const hints = ticket.vocabulary_hints.map((hint) => typeof hint === "string" ? hint : hint?.business_term ?? hint?.term ?? hint?.businessTerm).filter(Boolean);
  return hints.length ? ["", `Explicit vocabulary hints from ticket: ${hints.join(", ")}`] : [];
}

// Shares repository conventions with Claude and Codex implementation agents.
function coderProjectConventions(readTool = "read_file") {
  return [
    "Project conventions (AGENTS.md):",
    "- New files/functions only: add a short summary comment stating the business purpose alongside the technical description, in the same language as the code, without secrets. Do not add summaries to existing files/functions.",
    `- Before naming a new file/function/module/variable, call ${readTool} on vocabulary/glossary.md and use the standardized term; prefer ticket vocabulary_hints when present. Never edit vocabulary/glossary.md.`,
    `- Every file must stay at or under 250 lines (check ${readTool} total_lines); split the file instead of growing past the limit.`,
    "- For tests, verify executable behavior and state transitions whenever possible. If a source assertion is necessary, use whitespace and attribute-order independent patterns; never require HTML/JSX attributes to appear in one exact order.",
    "- Stay inside ticket scope; no unrelated refactors or while-I'm-here changes.",
    "- Never swallow errors in catch: log, rethrow, or reference the caught error; best-effort probes use // eslint-disable-next-line no-silent-catch -- <reason>."
  ];
}

// Builds the fixed Claude Forge tool-lab prompt.
export function buildToolTestPrompt(taskId, targetPath, allowedPrefixes) {
  const writeDiffInput = { path: targetPath, content: "tool-lab\n", before_checksum: null };
  return [
    `Run the fixed six-tool Forge MCP integration test ${taskId}.`,
    "Use only Forge MCP tools; do not use built-in shell, file, patch, or search tools.",
    "Call exactly these Forge MCP tools in order: search_code, read_file, write_diff, run_test, check_test, report_done.",
    `Call search_code once for backend/package.json with kind file, limit 5, and allowed_prefixes ${JSON.stringify(allowedPrefixes)}.`,
    "Then call read_file with only path for backend/package.json.",
    `Then call write_diff once with exactly this JSON input: ${JSON.stringify(writeDiffInput)}.`,
    "Then call run_test once with no arguments, check the returned job, and report the final status.",
    "Finally call report_done once with a concise summary. Stop after report_done."
  ].join("\n");
}

// Builds Claude's governed ticket prompt for implementation work.
export function buildToolTicketPrompt(ticket, targetPath, allowedPrefixes, complexity, directCode = false, immutableScope = false) {
  const acceptance = (ticket?.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
  const allowedJson = JSON.stringify(allowedPrefixes);
  const backendRequired = isBackendTicket(ticket);
  const instructions = [
    `Discover the implementation from the ticket title, objective and acceptance criteria. Search and read relevant code within ${allowedJson}; choose the files yourself. No file is a mandatory target merely because it was found first.`,
    "Use search_code and the available file-reading tools to find actual symbols and dependencies; inspect source before editing and add focused tests for the behavior you change.",
    ...(backendRequired ? ["If backend behavior is required, locate the relevant backend implementation and tests from the ticket rather than assuming a fixed route or service file."] : [])
  ];
  if (directCode) instructions.splice(0, 2, `This is a direct coding request. Do not use graph candidate retrieval. Discover files with search_code or Claude Glob/Grep inside approved prefixes ${allowedJson}; use read_file for metadata and symbol ranges, then Read for source. You may read and edit schemas/, read workflows/ only, and must not access docs/.`);
  if (immutableScope) instructions.splice(0, 2, `This ticket has a signed immutable manifest. Work only on these exact paths ${allowedJson}; do not use prepass or candidate retrieval and do not infer a target_path. Read each relevant manifest file with read_file and Read, then edit only manifest paths.`);
  return [
    "Complete the following ticket using Forge tools only; do not use built-in shell, file, patch, or search tools.",
    "Before editing code, read workflows/agents/coder/README.md source with Forge Read using start_line:1 and end_line up to 80; this workflows path is read-only for coders.",
    "",
    `Ticket ${ticket?.id ?? ""}: ${ticket?.title ?? ""}`,
    `Objective: ${ticket?.objective ?? ""}`,
    ...(acceptance ? ["Acceptance criteria:", acceptance] : []),
    ...ticketVocabularyHints(ticket),
    "",
    ...instructions,
    ...coderProjectConventions("Read"),
    "Hardening boundary: implement only hardening or fixes in the ticket's persisted scope and approved manifest. Do not rewrite boundaries already marked PASS in the acceptance report, weaken fail-closed gates, alias retired routes, or change governance authority.",
    "Production gate: the Coder cannot mark production accepted, release-ready, or done solely from implementation evidence. Preserve BLOCKED/NOT ACCEPTED FOR PRODUCTION until the required canary, terminal receipt, and release authority evidence exist.",
    `Budget discipline: you have a discovery budget of ${complexity.discovery_budget} exploration calls. The next action after identifying the target and relevant context is edit_diff or write_diff; do not spend the full budget by default. Every discovery result includes discovery_budget.remaining — start editing before it reaches 0. Productive discovery may receive one bounded extension. Re-read nothing you already read; prefer edit_diff with an exact anchor over re-reading whole files. Do not run run_test before at least one edit_diff/write_diff succeeded.`,
    immutableScope ? "Immutable-manifest search discipline: candidate retrieval is unavailable. Read and edit only approved manifest paths." : "Search discipline: use search_code, Glob and Grep inside approved prefixes, then confirm symbols and file contents with current source. Search using title, objective and acceptance criteria; avoid repeating queries that returned no matches without new evidence.",
    "Symbol check: if the ticket symbol is missing from the file or its content no longer matches the ticket reason, the file changed since tracing — re-discover via search_code instead of editing blind.",
    "Tool enforcement: read_file({path}) returns cached metadata, symbol ranges and scoped graph, never source for coders. Read source with Read({file_path,start_line,end_line}), at most 80 lines. If a symbol exceeds 80 lines, read successive ranges. Exploration that yields no new information 3 times in a row is refused by the tool — act on what you have.",
    "Claude coder may use Forge Read, Glob, and Grep; native built-ins remain disabled. Use the whole-file checksum returned by Read or read_file as before_checksum for write_diff/edit_diff; never send the string \"null\". Use JSON null only when intentionally creating a new file.",
    "For an existing file, use edit_diff with a small exact anchor and replacement. Use write_diff only for a new file or an existing file within the 250-line limit. If write_diff returns DESTRUCTIVE_OVERWRITE or CONTENT_TOO_LARGE, retry with edit_diff; do not stop or report done.",
    "If a governed tool call fails, fix the inputs and retry — do not continue with write_diff/commit_changes on an unknown target.",
    "Mandatory completion sequence: commit changes, run_test and poll check_test until passed, then call report_done with summary, acceptance_criteria (one entry per ticket criterion), acceptance_coverage (one entry per criterion keyed by stable criterion_id such as AC-1; use status=verified only for passing commands), implementation_scope (actual changed_files, not_changed_files, scope_rationale), and typed evidence. Do not call Reviewer tools or submit finding resolutions. Behavioral and visual criteria need focused executed tests. If report_done reports missing fields, supplement the saved draft. Stop after the report."
  ].join("\n");
}
