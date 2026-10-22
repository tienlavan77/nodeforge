// Builds governed ticket and tool-lab prompts for Claude and Codex agents.
import { isBackendTicket } from "./nodeforge-task-scope.js";
import { CODER_AUTONOMY_PROMPT } from "../../shared/implementation-autonomy.js";

const VERIFICATION_SCOPE_INSTRUCTIONS = "Verification scope: the ticket verification_plan and changed tests are mandatory acceptance checks. Additional import-related tests, shared schema validation and UI build are supplemental regression checks. Node compares failing supplemental checks against the pre-ticket source with the same recorded environment. Do not expand ticket scope to repair preexisting_failure checks. Repair introduced/changed failures using diagnostic blocking fields; unattributed failures require baseline evidence, not speculative changes. Never weaken assertions, skip tests, or downgrade acceptance criteria to obtain PASS.";

const BROWSER_SCENARIO_INSTRUCTIONS = "Browser verification: implement each approved scenario_path module in your commit. Export createBrowserFixture({sourceRoot,build}) => {html,assets} with real bundled project components, and browserAssertions as an object mapping EVERY exact approved assertion string to async ({page,viewport,origin}) functions that assert behavior or throw. assets maps local URL paths to text content. Node owns Chromium, approved viewport execution, network isolation and receipts; do not return fabricated receipts or replace browser checks with unit tests. See backend/src/modules/supervisor/browser-verification.md for the contract.";

export const COMPLEXITY_FALLBACK = Object.freeze({ effort: "medium", discovery_budget: 8, thinking: { type: "enabled", budgetTokens: 4096 } });

// Builds the Codex ticket instructions for governed implementation work.
export function buildCodexTicketPrompt(ticket, targetPath, allowedPrefixes, complexity, directCode = false, immutableScope = false) {
  const acceptance = (ticket?.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
  const verification = formatVerificationPlan(ticket);
  const allowedJson = JSON.stringify(allowedPrefixes);
  const backendRequired = isBackendTicket(ticket);
  const instructions = [
    `Discover the implementation from the ticket title, objective and acceptance criteria. Search and read relevant code within ${allowedJson}; choose the files yourself. No file is a mandatory target merely because it was found first.`,
    "Use the canonical Forge tools search_tree, list_files, search_text, read_file and read_lines to discover files and inspect current source; add focused tests for changed behavior.",
    ...(backendRequired ? ["If backend behavior is required, locate the relevant backend implementation and tests from the ticket rather than assuming a fixed route or service file."] : [])
  ];
  if (directCode) instructions.splice(0, 2, `This is a direct coding request. Do not use graph candidate retrieval. Discover with search_tree, list_files or search_text inside approved prefixes ${allowedJson}; use read_file/read_lines for source. You may read and edit schemas/, read workflows/ only, and must not access docs/.`);
  if (immutableScope) instructions.splice(0, 2, `This ticket has a signed immutable manifest. Work only on these exact paths ${allowedJson}; do not use prepass or candidate retrieval and do not infer a target_path. Read relevant manifest files with read_file/read_lines and edit only manifest paths.`);
  return [
    `Complete the following ticket using Forge tools only; do not use built-in shell, file, patch, or search tools.`,
    "Before editing code, read workflows/agents/coder/README.md with read_lines; this workflows path is read-only for coders.",
    "",
    `Ticket ${ticket?.id ?? ""}: ${ticket?.title ?? ""}`,
    `Objective: ${ticket?.objective ?? ""}`,
    ...(acceptance ? ["Acceptance criteria:", acceptance] : []),
    CODER_AUTONOMY_PROMPT,
    ...(verification ? ["Forge verification plan (Forge reruns this after commit):", verification] : []),
    VERIFICATION_SCOPE_INSTRUCTIONS,
    ...ticketVocabularyHints(ticket),
    "",
    ...instructions,
    "Hardening boundary: you may implement only hardening or fixes in the ticket's persisted scope and approved manifest. Do not rewrite boundaries already marked PASS in the acceptance report, weaken fail-closed gates, alias retired routes, or change governance authority.",
    "Production gate: the Coder cannot mark production accepted, release-ready, or done solely from implementation evidence. Preserve BLOCKED/NOT ACCEPTED FOR PRODUCTION until the required canary, terminal receipt, and release authority evidence exist.",
    ...coderProjectConventions("read_file"),
    "Use English for code identifiers and implementation prose; purpose comments may be entirely English or entirely Vietnamese under the project conventions below.",
    `Budget discipline: you have a hard wall-clock deadline and a discovery budget of ${complexity.discovery_budget} exploration calls. The next action after identifying the target and relevant context is edit_diff or write_diff; do not spend the full budget by default. Respect the discovery budget and start editing promptly. Productive discovery may receive one bounded extension. Re-read nothing you already read; prefer edit_diff with an exact anchor over re-reading whole files.`,
    immutableScope ? "Immutable-manifest search discipline: candidate retrieval is unavailable. Read and edit only approved manifest paths." : directCode ? "Direct-code search discipline: use search_tree, list_files and search_text inside approved prefixes." : "Search discipline: use search_tree/list_files for paths and search_text for live code; confirm relevant source with read_file/read_lines. Do not repeat a search that returned no matches without new evidence.",
    "Use read_file({path,offset,limit}) for bounded source windows and metadata; use read_lines({path,start_line,end_line}) for precise line windows, at most 80 lines. Both return the current whole-file sha256.",
    "Symbol check: if the expected symbol is missing or no longer matches the ticket, rediscover with search_text instead of editing blind.",
    "Stay within the ticket scope for every tool. read_lines requires path, start_line and end_line; read no more than 80 lines per call.",
    "Use the whole-file sha256 returned by read_file/read_lines as before_checksum for write_diff/edit_diff. Use JSON null only when creating a new file.",
    "Node derives commit paths from the ticket ledger and commits the full final content of every file Coder changed in this ticket, including preexisting changes within those files; files outside the ticket are excluded. A dirty pre-ticket file or a different Git parent is not a commit blocker. Current file hashes must still match the recorded ticket writes. Node runs the listed verification plan after commit. Do not invent, omit, or downgrade a criterion; add focused tests when the plan calls for them. Node owns artifacts and criterion evidence.",
    "For extra focused checks, commit first and call run_check({type,command}); it returns the final result and a source-bound receipt directly. Final acceptance still uses Node's verification plan. Use push_commit({commit_sha}) only when pushing is requested, with the exact latest ticket commit SHA.",
    BROWSER_SCENARIO_INSTRUCTIONS,
    "When the ticket is satisfied, call commit_changes with a concise message and no paths, then call report_done with a summary and any scope rationale or human evidence. Node supplies changed files, criterion IDs, command evidence, and artifact identity. Node holds report_done while verification runs and returns the terminal result to this same session. Wait for the tool result; do not poll, recommit unchanged source or start duplicate tests. After PASS, finish the final report. After FAIL, repair only the evidenced cause using the returned command output and artifact reference. Do not call Reviewer tools or submit finding resolutions. Stop only after report_done succeeds.",
    "If scope, contract authority, access, security, or ambiguous acceptance blocks implementation, call report_done with status: blocked, summary, blocker: {reason_code, owner_action}, and source evidence. Do not invent authority or create a commit merely to report a blocker. CODER_BLOCKED acknowledges escalation, not completion; stop this invocation. Node routes the retained checkpoint to SL, who consults AM only for a missing design decision; Owner is needed only for an evidenced boundary beyond existing authority."
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
    "- Installed backend/UI node_modules are read-only context. Locate package guidance with search_tree at its exact directory, then read_file/read_lines using the returned filename; do not guess .md versus .mdx or request Architecture approval merely to read it.",
    "- New files/new symbols only: add detailed purpose comments describing the business purpose and technical description at the top of new files and before new function/symbol definitions, without secrets. Write each comment entirely in English or entirely in Vietnamese; do not mix sentence structure between languages. Technical identifiers, tags and paths may remain unchanged. Do not add summaries to existing files/symbols or rewrite historical comments.",
    `- Before naming a new file/function/module/variable, call ${readTool} on vocabulary/glossary.md and use the standardized term; prefer ticket vocabulary_hints when present. Never edit vocabulary/glossary.md.`,
    `- Every file, across all file types, must stay at or under 250 code_lines (check ${readTool} code_lines), excluding comment-only and blank lines; split the file instead of growing past the limit. Physical total_lines remains the coordinate system for source reads, not the code budget; keep source windows at most 80 physical lines.`,
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
  const verification = formatVerificationPlan(ticket);
  const allowedJson = JSON.stringify(allowedPrefixes);
  const backendRequired = isBackendTicket(ticket);
  const instructions = [
    `Discover the implementation from the ticket title, objective and acceptance criteria. Search and read relevant code within ${allowedJson}; choose the files yourself. No file is a mandatory target merely because it was found first.`,
    "Use the canonical Forge tools search_tree, list_files, search_text, read_file and read_lines to discover files and inspect current source; add focused tests for changed behavior.",
    ...(backendRequired ? ["If backend behavior is required, locate the relevant backend implementation and tests from the ticket rather than assuming a fixed route or service file."] : [])
  ];
  if (directCode) instructions.splice(0, 2, `This is a direct coding request. Do not use graph candidate retrieval. Discover with search_tree, list_files or search_text inside approved prefixes ${allowedJson}; use read_file/read_lines for source. You may read and edit schemas/, read workflows/ only, and must not access docs/.`);
  if (immutableScope) instructions.splice(0, 2, `This ticket has a signed immutable manifest. Work only on these exact paths ${allowedJson}; do not use prepass or candidate retrieval and do not infer a target_path. Read relevant manifest files with read_file/read_lines, then edit only manifest paths.`);
  return [
    "Complete the following ticket using Forge tools only; do not use built-in shell, file, patch, or search tools.",
    "Before editing code, read workflows/agents/coder/README.md with read_lines using start_line:1 and end_line up to 80; this workflows path is read-only for coders.",
    "",
    `Ticket ${ticket?.id ?? ""}: ${ticket?.title ?? ""}`,
    `Objective: ${ticket?.objective ?? ""}`,
    ...(acceptance ? ["Acceptance criteria:", acceptance] : []),
    CODER_AUTONOMY_PROMPT,
    ...(verification ? ["Forge verification plan (Forge reruns this after commit):", verification] : []),
    VERIFICATION_SCOPE_INSTRUCTIONS,
    ...ticketVocabularyHints(ticket),
    "",
    ...instructions,
    ...coderProjectConventions("read_file"),
    "Hardening boundary: implement only hardening or fixes in the ticket's persisted scope and approved manifest. Do not rewrite boundaries already marked PASS in the acceptance report, weaken fail-closed gates, alias retired routes, or change governance authority.",
    "Production gate: the Coder cannot mark production accepted, release-ready, or done solely from implementation evidence. Preserve BLOCKED/NOT ACCEPTED FOR PRODUCTION until the required canary, terminal receipt, and release authority evidence exist.",
    `Budget discipline: you have a discovery budget of ${complexity.discovery_budget} exploration calls. The next action after identifying the target and relevant context is edit_diff or write_diff; do not spend the full budget by default. Every discovery result includes discovery_budget.remaining — start editing before it reaches 0. Productive discovery may receive one bounded extension. Re-read nothing you already read; prefer edit_diff with an exact anchor over re-reading whole files.`,
    immutableScope ? "Immutable-manifest search discipline: candidate retrieval is unavailable. Read and edit only approved manifest paths." : "Search discipline: use search_tree/list_files for paths and search_text for source discovery inside approved prefixes. Search from title, objective and acceptance criteria; avoid repeating queries that returned no matches without new evidence.",
    "Symbol check: if the expected symbol is missing or changed, rediscover with search_text instead of editing blind.",
    "Use read_file({path,offset,limit}) or read_lines({path,start_line,end_line}) for source windows of at most 80 lines. Both return current source and the whole-file sha256.",
    "Claude's built-in tools are disabled. Codex native command, file-change and web tools are blocked for Coder; use only canonical Forge tools. Use the returned checksum as before_checksum for write_diff/edit_diff.",
    "For an existing file, use edit_diff with a small exact anchor and replacement. Use write_diff only for a new file or an existing file within the 250 code_lines limit, excluding comment-only and blank lines. If write_diff returns DESTRUCTIVE_OVERWRITE or CONTENT_TOO_LARGE, retry with edit_diff; do not stop or report done.",
    "If a governed tool call fails, fix the inputs and retry — do not continue with write_diff/commit_changes on an unknown target.",
    "For extra focused checks, commit first and call run_check({type,command}); it returns the final result and a source-bound receipt directly. Final acceptance still uses Node's verification plan. Use push_commit({commit_sha}) only when pushing is requested, with the exact latest ticket commit SHA.",
    BROWSER_SCENARIO_INSTRUCTIONS,
    "For a scope, contract, access, security, or acceptance blocker, call report_done with status: blocked, summary, blocker: {reason_code, owner_action}, and source evidence. Do not invent authority or a commit. CODER_BLOCKED acknowledges escalation, not completion: stop this invocation. Node routes the retained checkpoint to SL; consult AM only for a missing design decision, not to repeat a retained contract. Owner is needed only beyond existing authority. This is the only exception to the completion sequence below.",
    "Mandatory completion sequence: call commit_changes with a concise message and no paths, then call report_done with a summary and any scope rationale or human evidence. Node derives commit paths, runs the listed verification plan, and attaches criterion IDs, changed files, and command evidence. Node holds report_done while verification runs and returns the terminal result to this same session. Wait for the tool result; do not poll, recommit unchanged source or start duplicate tests. After PASS, finish the final report. After FAIL, repair only the evidenced cause using the returned command output and artifact reference. Do not call Reviewer tools or submit finding resolutions. Stop only after report_done succeeds. CODER_EVIDENCE_PENDING means completion was rejected: run the missing checks and retry with verified acceptance coverage; do not hand incomplete evidence to Human Review."
  ].join("\n");
}

// Formats the immutable criterion mapping so Coder knows exactly what Forge will verify.
function formatVerificationPlan(ticket) {
  const ownerPolicy = ticket?.owner_decisions?.length ? `Owner-approved policy decisions for this exact Sprint Plan: ${JSON.stringify(ticket.owner_decisions)}\n` : "";
  if (!Array.isArray(ticket?.verification_plan) || !ticket.verification_plan.length) return ownerPolicy;
  return ownerPolicy + ticket.verification_plan.map((step) => {
    const details = [step.scenario_path ? `scenario_path=${step.scenario_path}` : "", step.test_path ? `test_path=${step.test_path}` : "", Array.isArray(step.viewports) ? `viewports=${step.viewports.join(",")}` : "", Array.isArray(step.assertions) ? `assertions=${step.assertions.join("; ")}` : ""].filter(Boolean);
    return `- ${step.criterion_ids?.join(", ") ?? "unbound"}: ${step.kind}${details.length ? ` (${details.join("; ")})` : ""}`;
  }).join("\n");
}
