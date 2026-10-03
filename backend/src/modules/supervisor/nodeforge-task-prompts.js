// Builds governed ticket and tool-lab prompts for Claude and Codex agents.
import { isBackendTicket } from "./nodeforge-task-scope.js";

export const COMPLEXITY_FALLBACK = Object.freeze({ effort: "medium", discovery_budget: 8, thinking: { type: "enabled", budgetTokens: 4096 } });

// Builds the Codex ticket instructions for governed implementation work.
export function buildCodexTicketPrompt(ticket, targetPath, allowedPrefixes, complexity, directCode = false, immutableScope = false) {
  const acceptance = (ticket?.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
  const allowedJson = JSON.stringify(allowedPrefixes);
  const backendRequired = isBackendTicket(ticket);
  const instructions = targetPath
    ? [
        `Primary target is ${JSON.stringify(targetPath)}; it is inside allowed prefixes ${allowedJson}. You may modify additional files inside those prefixes if the ticket requires it. Because the target path is explicit, skip select_code_graph_candidates and read the target directly; use rg_search only for a specific unseen symbol or dependency that the target read proves necessary.`,
        `Discovery convergence rule: identify the target file/symbol first, then read only the minimum surrounding context needed to edit safely. Call rg_files or rg_search ONLY to locate a file or identifier you have not yet seen in a prior tool result — do not re-search a path already returned, and do not run verification searches before the first edit. Once the target and its relevant context are identified, begin edit_diff or write_diff on the next turn. Respect the discovery budget and start editing promptly.`,
        ...(backendRequired ? ["Backend requirement: this ticket has explicit backend acceptance criteria. Before editing UI, discover and read the backend route/service/store files (backend/src/application/ticket-crud-service.js, backend/src/transport/http/forge-v1-router.js, backend tests). You must modify or verify a backend implementation file and cover it with tests; do not call report_done unless a backend file appears in changed_paths."] : [])
      ]
    : [
        `Allowed prefixes are ${allowedJson}. Select relevant files via discovery (select_code_graph_candidates). You may modify any file inside those prefixes if the ticket requires it.`,
        `Discovery convergence rule: identify the target file/symbol first, then read only the minimum surrounding context needed to edit safely. Call rg_files or rg_search ONLY to locate a file or identifier you have not yet seen in a prior tool result — do not re-search a path already returned, and do not run verification searches before the first edit. Once the target and its relevant context are identified, begin edit_diff or write_diff on the next turn. Respect the discovery budget and start editing promptly.`,
        ...(backendRequired ? ["Backend requirement: this ticket has explicit backend acceptance criteria. Discover and read the backend route/service/store files and backend tests. You must modify or verify a backend implementation file and cover it with tests; do not call report_done unless a backend file appears in changed_paths."] : [])
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
    `Budget discipline: you have a hard wall-clock deadline and a discovery budget of ${complexity.discovery_budget} exploration calls. The next action after identifying the target and relevant context is edit_diff or write_diff; do not spend the full budget by default. Respect the discovery budget and start editing promptly. Simple tickets do not receive automatic discovery escalation. Re-read nothing you already read; prefer edit_diff with an exact anchor over re-reading whole files. Do not run run_test before at least one edit_diff/write_diff succeeded.`,
    directCode || immutableScope ? "Direct or immutable-manifest search discipline: candidate retrieval is unavailable. Read only approved paths and use search tools only within the exact manifest scope." : "Search discipline: use search_code for indexed file and symbol discovery, rg_files for paths, and rg_search for live text. Do not repeat a search that returned no matches without new evidence.",
    "Call read_file({path}) for cached metadata, current symbol start_line/end_line and scoped graph; it never returns source for coders. Read source with sed_lines({path,start_line,end_line}), at most 80 lines.",
    "Symbol check: if the ticket symbol is missing from the file or no longer matches the ticket reason, re-discover via rg_search instead of editing blind.",
    "Tool enforcement: sed_lines requires path, start_line, and end_line; read at most 80 lines per call and stay within the ticket scope.",
    "Use the whole-file sha256 returned by sed_lines as before_checksum for write_diff/edit_diff. Use JSON null only when creating a new file.",
    ...(targetPath ? [`Completion gate: report_done is blocked until ${targetPath} appears in changed_paths. Any report_done that does not include the target file will fail with REPORT_SCOPE_INVALID. After editing the target, commit, run_test, check_test and report_done; do not continue with unrelated discovery or edits to bypass this gate.`] : []),
    `When the ticket is satisfied, commit changes, run_test and poll check_test until passed, then call report_done with summary, acceptance_criteria quoted verbatim from the ticket, implementation_scope (actual changed_files, not_changed_files, scope_rationale), typed evidence and reviewer_notes. Explain why other allowed files did not need changes. If report_done says fields are missing or invalid, the original report is saved: call report_done again with only the named missing or corrected fields for the same artifact; do not rewrite the summary. After a new commit/artifact, finish report_done before respond_to_review. For an open finding, use respond_to_review with the exact REV-n ID, passed commit/artifact/source revision and an idempotency key to accept or dispute with evidence; this does not close the finding. Stop after the complete response or report. Do not claim a finding is fixed without Reviewer confirmation.`
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
    `Call commit_changes with exactly: ${JSON.stringify({ message: `Codex Forge six-tool test ${taskId}` })}.`,
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
  const instructions = targetPath
    ? [
        `Primary target is ${JSON.stringify(targetPath)}; it is inside allowed prefixes ${allowedJson}. You may modify additional files inside those prefixes if the ticket requires it. Because the target path is explicit, skip select_code_graph_candidates and read the target directly; use search_code only for a specific unseen symbol or dependency that the target read proves necessary.`,
        `Discovery convergence rule: identify the target file/symbol first, then read only the minimum surrounding context needed to edit safely. Call select_code_graph_candidates or search_code ONLY to locate a file or identifier you have not yet seen in a prior tool result — do not re-search a path already returned, and do not run verification searches before the first edit. Once the target and its relevant context are identified, begin edit_diff or write_diff on the next turn. Every discovery result includes discovery_budget.remaining; respect it and start editing before it reaches 0.`,
        ...(backendRequired ? ["Backend requirement: this ticket has explicit backend acceptance criteria. Before editing UI, discover and read the backend route/service/store files (backend/src/application/ticket-crud-service.js, backend/src/transport/http/forge-v1-router.js, backend tests). You must modify or verify a backend implementation file and cover it with tests; do not call report_done unless a backend file appears in changed_paths."] : [])
      ]
    : [
        `Allowed prefixes are ${allowedJson}. Select relevant files via discovery (select_code_graph_candidates). You may modify any file inside those prefixes if the ticket requires it.`,
        `Discovery convergence rule: identify the target file/symbol first, then read only the minimum surrounding context needed to edit safely. Call select_code_graph_candidates or search_code ONLY to locate a file or identifier you have not yet seen in a prior tool result — do not re-search a path already returned, and do not run verification searches before the first edit. Once the target and its relevant context are identified, begin edit_diff or write_diff on the next turn. Every discovery result includes discovery_budget.remaining; respect it and start editing before it reaches 0.`,
        ...(backendRequired ? ["Backend requirement: this ticket has explicit backend acceptance criteria. Discover and read the backend route/service/store files and backend tests. You must modify or verify a backend implementation file and cover it with tests; do not call report_done unless a backend file appears in changed_paths."] : [])
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
    `Budget discipline: you have a discovery budget of ${complexity.discovery_budget} exploration calls. The next action after identifying the target and relevant context is edit_diff or write_diff; do not spend the full budget by default. Every discovery result includes discovery_budget.remaining — start editing before it reaches 0. Simple tickets do not receive automatic discovery escalation. Re-read nothing you already read; prefer edit_diff with an exact anchor over re-reading whole files. Do not run run_test before at least one edit_diff/write_diff succeeded.`,
    directCode || immutableScope ? "Direct or immutable-manifest search discipline: candidate retrieval is unavailable. Read only approved paths and use search tools only within the exact manifest scope, then edit promptly." : "Search discipline: select_code_graph_candidates is your map — read its candidate files first. Each ticket-traced candidate carries a symbol field: locate by symbol name first (symbol_map or search_code kind symbol), never by line number — line numbers go stale after other tickets edit the same file. Never search for text you are guessing at (UI labels, headings, ticket phrasing); search_code exists ONLY to verify or extend identifiers you already saw in a tool result. If a search_code call returns 0 matches, do not rephrase the same guess — read a candidate file window instead.",
    "Symbol check: if the ticket symbol is missing from the file or its content no longer matches the ticket reason, the file changed since tracing — re-discover via search_code instead of editing blind.",
    "Tool enforcement: read_file({path}) returns cached metadata, symbol ranges and scoped graph, never source for coders. Read source with Read({file_path,start_line,end_line}), at most 80 lines. If a symbol exceeds 80 lines, read successive ranges. Exploration that yields no new information 3 times in a row is refused by the tool — act on what you have.",
    "Claude coder may use Forge Read, Glob, and Grep; native built-ins remain disabled. Use the whole-file checksum returned by Read or read_file as before_checksum for write_diff/edit_diff; never send the string \"null\". Use JSON null only when intentionally creating a new file.",
    "For an existing file, use edit_diff with a small exact anchor and replacement. Use write_diff only for a new file or an existing file within the 250-line limit. If write_diff returns DESTRUCTIVE_OVERWRITE or CONTENT_TOO_LARGE, retry with edit_diff; do not stop or report done.",
    "If a governed tool call fails, fix the inputs and retry — do not continue with write_diff/commit_changes on an unknown target.",
    "Mandatory completion sequence: commit changes, run_test and poll check_test until passed, then call report_done with summary, acceptance_criteria quoted verbatim from the ticket, implementation_scope (actual changed_files, not_changed_files, scope_rationale), typed evidence and reviewer_notes. Explain unchanged allowed files. If report_done reports missing or invalid fields, the original report is saved; supplement only those fields in another report_done call for the same artifact without repeating the summary. After a new commit/artifact, finish report_done before respond_to_review. For an open finding, respond_to_review may submit an accept or dispute position with the exact REV-n ID and passed commit/artifact/source revision, without making a fake edit. It does not close the finding. Stop after a complete response or report. If verification fails, fix code and verify a new revision."
  ].join("\n");
}
