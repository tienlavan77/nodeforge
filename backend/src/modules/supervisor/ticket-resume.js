// Resume context for crash recovery — keeps provider session identity, per-turn
// history across RUNs so a resumed ticket continues the
// previous execution instead of restarting blind. Only compact turn summaries
// are persisted; file contents never go through the checkpoint.
import { currentReviewFindings } from "./review-query-records.js";
import { executeReportVerificationWait } from "./ticket-report-verification-wait.js";
import { admissionPrompt } from "./blocker-execution-admission.js";
import { blockerHandoffPrompt } from "./blocker-handoff-policy.js";
import { ConfigurationError } from "../../shared/errors.js";
import { blockerContractPrompt } from "./blocker-contract-evidence.js";
import { engineeringToolName } from "../../tools/engineering-tool-names.js";
import { resumeRecovery, reviewRepairInstructions } from "./review-repair-handoff.js";
import { assertReadNotRepeated, forgetRead, rememberRead, sanitizeReadCache, snapshotReadCache } from "./ticket-read-cache.js";

const MAX_HISTORY_TURNS = 12;

// normalizeResume - returns a safe resume snapshot or null when unusable.
export function normalizeResume(resume) {
  if (!resume || typeof resume !== "object") return null;
  if (resume.status === "completed") return null;
  return resume;
}

// createResumeState - mutable per-run state seeded from a prior checkpoint.
export function createResumeState(resume) {
  const clean = normalizeResume(resume);
  return {
    resume: clean,
    agentExchange: clean?.agent_exchange ?? null,
    verificationWait: clean?.verification_wait ?? null,
    sessionId: typeof clean?.session_id === "string" ? clean.session_id : null,
    threadId: typeof clean?.thread_id === "string" ? clean.thread_id : null,
    turnCount: Number.isInteger(clean?.last_completed_turn) ? clean.last_completed_turn : 0,
    completedTools: Array.isArray(clean?.completed_tools) ? clean.completed_tools.map(engineeringToolName) : [],
    turnHistory: Array.isArray(clean?.turn_history) ? clean.turn_history.map((entry) => ({ ...entry, tool: engineeringToolName(entry.tool) })) : [],
    changedPaths: Array.isArray(clean?.changed_paths) ? [...clean.changed_paths] : [],
    emptyCommitSeen: clean?.empty_commit_seen === true,
    readCache: sanitizeReadCache(clean?.read_cache),
    coderRulesRead: clean?.coder_rules_read === true || Object.keys(clean?.read_cache ?? {}).some((key) => key.startsWith("workflows/agents/coder/README.md#"))
  };
}

// recordTurn - appends a compact turn entry; returns the entry for checkpointing.
export function recordTurn(state, name, input, result) {
  name = engineeringToolName(name);
  const entry = {
    turn: state.turnCount + 1,
    tool: name,
    target: summarizeTarget(name, input),
    outcome: summarizeOutcome(result)
  };
  state.turnCount += 1;
  state.completedTools.push(name);
  state.turnHistory.push(entry);
  while (state.turnHistory.length > MAX_HISTORY_TURNS) state.turnHistory.shift();
  return entry;
}

// checkpointPayload - builds a checkpoint save that never drops session identity.
export function checkpointPayload(state, extra = {}) {
  if (!state) throw new ConfigurationError("Resume checkpoint payload requires run state.");
  const prior = Array.isArray(state.resume?.stage_progress) ? state.resume.stage_progress : [];
  const coderEntry = { stage: "coder", status: extra.status ?? "in_progress", turn: state.turnCount, last_tool: extra.last_tool ?? null, at: new Date().toISOString() };
  const stageProgress = prior.at(-1)?.stage === "coder" ? [...prior.slice(0, -1), coderEntry] : [...prior, coderEntry];
  const payload = {
    ...(state.resume ?? {}),
    ...(state.agentExchange ? { agent_exchange: state.agentExchange } : {}),
    verification_wait: state.verificationWait,
    session_id: state.sessionId ?? state.resume?.session_id ?? null,
    thread_id: state.threadId ?? state.resume?.thread_id ?? null,
    last_completed_turn: state.turnCount,
    completed_tools: [...state.completedTools],
    turn_history: [...state.turnHistory],
    empty_commit_seen: state.emptyCommitSeen === true,
    read_cache: snapshotReadCache(state.readCache),
    coder_rules_read: state.coderRulesRead === true,
    stage_progress: stageProgress,
    ...extra
  };
  if (Array.isArray(payload.review_findings)) payload.review_findings = currentReviewFindings(payload.review_findings);
  return payload;
}

// checkpointedRegistry - wraps the governed Forge tool registry so after every
// successful tool call progress is durably checkpointed. Session identity,
// compact turn history, and changed paths survive in the shared resume state,
// so a later RUN continues the previous execution instead of restarting blind.
// Turn counting starts from the seeded checkpoint for accurate progress.
export function checkpointedRegistry({ store, registry, taskId, targetPath, allowedPrefixes, complexity, selected, correlationId, resumeState = null, labMode = false, projectLogger = () => {} }) {
  if (!store || !registry) return registry;
  const state = resumeState ?? createResumeState(null);
  const wrapped = {};
  for (const [name, tool] of Object.entries(registry)) {
    if (typeof tool?.execute !== "function") { wrapped[name] = tool; continue; }
    wrapped[name] = Object.freeze({
      ...tool,
      async execute(input, context) {
        let result;
        try {
          if (selected?.role === "coder" && !labMode && (name === "write_diff" || name === "edit_diff") && !state.coderRulesRead) {
            throw Object.assign(new ConfigurationError("Read workflows/agents/coder/README.md with a Forge file tool before editing code."), { code: "CODER_RULES_REQUIRED" });
          }
          if (name === "report_done" && input?.status !== "blocked") await assertCommitBeforeReport(state, context, labMode, tool);
          if (name === "read_file") assertReadNotRepeated(state.readCache, input);
          result = name === "report_done" && input?.status !== "blocked"
            ? await executeReportVerificationWait({ tool, input, context, state, store, taskId, selected, correlationId, projectLogger, checkpointPayload })
            : await tool.execute(input, context);
          if (selected?.role === "coder" && ["read_file", "read_lines", "Read", "sed_lines"].includes(name) && (input?.path === "workflows/agents/coder/README.md" || input?.file_path === "workflows/agents/coder/README.md" || input?.file_path?.endsWith("/workflows/agents/coder/README.md")) && (name === "sed_lines" || name === "read_lines" ? result?.exit_code === 0 : typeof result?.content === "string")) state.coderRulesRead = true;
          if (name === "read_file") rememberRead(state.readCache, input, result);
          if (name === "write_diff" || name === "edit_diff") { forgetRead(state.readCache, input); state.emptyCommitSeen = false; }
        } catch (error) {
          if (name === "commit_changes" && error?.code === "GIT_EMPTY_COMMIT") state.emptyCommitSeen = true;
          throw error;
        }
        recordTurn(state, name, input, result);
        const changedSnapshot = Array.isArray(context?.changed_paths) ? [...context.changed_paths] : [];
        for (const path of changedSnapshot) if (!state.changedPaths.includes(path)) state.changedPaths.push(path);
        const done = name === "report_done";
        const payload = checkpointPayload(state, {
          task_id: taskId,
          correlation_id: correlationId,
          agent_id: selected?.agent_id ?? null,
          provider: selected?.provider ?? null,
          target_path: targetPath,
          allowed_prefixes: allowedPrefixes,
          complexity_level: complexity?.level ?? null,
          execution_context: context?.execution_context ?? null,
          engineering_catalog_version: context?.engineering_catalog_version ?? null,
          last_tool: name,
          changed_paths: changedSnapshot,
          status: done ? "completed" : "in_progress",
          ...(done ? { completed_at: new Date().toISOString() } : {})
        });
        if (done) {
          // eslint-disable-next-line no-silent-catch -- Checkpoint persist is best-effort; tool result already computed and gateway failure checkpoint covers crashes.
          await store.complete(taskId, payload).catch(() => null);
        } else {
          // eslint-disable-next-line no-silent-catch -- Checkpoint persist is best-effort; a failed save only loses resume granularity, never tool results.
          await store.save(payload).catch(() => null);
        }
        return result;
      }
    });
  }
  return wrapped;
}

// assertCommitBeforeReport - blocks completion until applied changes are committed.
async function assertCommitBeforeReport(state, context, labMode, tool) {
  if (labMode || context?.lab_mode || context?.labMode) return;
  if (state.emptyCommitSeen) return;
  if (state.changedPaths.length === 0) return;
  const tools = state.completedTools;
  const lastEdit = Math.max(tools.lastIndexOf("write_diff"), tools.lastIndexOf("edit_diff"));
  const lastCommit = tools.lastIndexOf("commit_changes");
  if (lastCommit === -1 || (lastEdit !== -1 && lastEdit > lastCommit)) {
    if (await tool.reconcileCommit?.(context)) return;
    throw Object.assign(new ConfigurationError("Changes are present but commit_changes has not succeeded after the last edit. Call commit_changes with an appropriate message before report_done."), { code: "COMMIT_MISSING", tool: "commit_changes" });
  }
}


// failureDetail - compact gateway/crash error for the failure-path checkpoint.
export function failureDetail(error) {
  const message = typeof error?.message === "string" && error.message ? error.message : "unknown execution error";
  return { code: error?.code ?? "GATEWAY_FAILED", message: message.slice(0, 500), at: new Date().toISOString() };
}

// buildResumePrompt - prefixes the ticket prompt with compact resume context.
export function buildResumePrompt(prompt, state, meta = {}) {
  if (!state?.resume) return prompt;
  const recovery = resumeRecovery(state.resume);
  const history = state.turnHistory.length
    ? state.turnHistory.map((entry) => `- turn ${entry.turn} ${entry.tool} ${entry.target} -> ${entry.outcome}`.trim()).join("\n")
    : `Tools already completed successfully (do NOT call them again for the same inputs): ${(state.completedTools ?? []).join(", ") || "(none recorded)"}.`;
  return [
    `RESUMED RUN: a previous execution stopped after completing turn ${state.turnCount}.`,
    "The current tool catalog replaces legacy rg_files/rg_search/sed_lines with list_files/search_text/read_lines. Historical search_code, run_test and check_test entries are receipts only; they are not available in the current Coder catalog. Use search_text for source discovery and run_check for focused checks. Do not repeat completed mutations.",
    state.sessionId ? "Provider session resumed; earlier assistant context may be available, but the worktree is the source of truth." : "No provider session survived; the worktree below is the source of truth.",
    ...(state.verificationWait ? [`Node retained verification/report checkpoint: ${JSON.stringify(state.verificationWait)}. Continue from this report draft. Call report_done once to reattach to Node verification; Node waits internally and returns terminal evidence. Do not recreate edits, recommit unchanged source or poll tools.`] : []),
    "Completed turns (do NOT repeat these tool calls with the same inputs):",
    ...(recovery?.status === "resolved" && recovery.disposition?.guidance ? [`Automatic blocker investigation resolved an issue within existing approved scope. This is guidance, not new contract/permission approval: ${recovery.disposition.guidance}`] : []),
    ...(recovery?.status === "resolved" ? [blockerHandoffPrompt()] : []),
    ...(state.resume.review_policy_amendment ? ["Node recorded the Owner's review-policy amendment in the current Sprint revision: there is no fixed limit on Coder revision/Reviewer cycles. Earlier review-count caps and exhaustion blockers are superseded. Continue the retained finding repair from this checkpoint; preserve independent review, verification, scope, and existing tool authorization."] : []),
    recovery?.status === "approval_retry"
      ? `NODE OPERATIONAL RETRY: the automatic approval service returned HTTP 503 without a verdict. The 30-second retry wait has elapsed. Resume the unfinished operation from this checkpoint and submit it through the unchanged tool approval path for a fresh verdict. Preserve completed edits; do not restart the ticket, skip approval, change sandbox policy, relocate the operation, or claim approval was granted. Receipts: ${JSON.stringify(recovery.approval_retry?.receipts ?? [])}`
      : admissionPrompt(recovery?.execution_admission),
    ...(recovery?.status !== "superseded_by_review" && recovery?.ticket_progress ? [`Retained criterion progress: ${JSON.stringify(recovery.ticket_progress)}. Continue remaining implementation/checks at this checkpoint. Preserve written work; revalidate source and evidence before relying on verified status. Do not recreate a complete proposal dossier or restart completed edits.`] : []),
    ...(recovery?.status === "resolved" && recovery.disposition?.technical_result ? [`Validated technical handoff: ${JSON.stringify({ result: recovery.disposition.technical_result, evidence: recovery.disposition.evidence })}. Follow these implementation and focused verification steps within the unchanged ticket. Existing tool approval decisions remain enforced; this handoff does not authorize a denied operation.`] : []),
    ...(recovery?.status === "resolved" && recovery?.coder_exchange?.candidate ? [`Approved Coder candidate dossier (review role: ${recovery.coder_exchange.review_role ?? "architecture_manager"}): ${JSON.stringify(recovery.coder_exchange)}. Preserve the reviewed constraints. This technical review grants no execution-tool permissions; all mutations and verification still use existing gates. A materially changed proposal requires another technical review by the coordinating role.`] : []),
    ...(recovery?.owner_decision ? [`Project owner decided blocker option "${recovery.owner_decision.option_id}" (${recovery.owner_decision.option_description ?? ""})${recovery.owner_decision.reason ? ` — Reason: ${recovery.owner_decision.reason}` : ""}. Continue implementation strictly within this chosen option.`] : []),
    blockerContractPrompt(state.resume.contract_decisions),
    history,
    `Files already changed in the worktree: ${[...new Set([...state.changedPaths, ...(meta.changedPaths ?? [])])].join(", ") || "(none)"} — verify with read_file if needed, then continue with the next unfinished step.`,
    `Previous agent: ${meta.agentId ?? state.resume.agent_id ?? "unknown"} (${meta.provider ?? state.resume.provider ?? "unknown provider"}).`,
    ...(state.resume.phase === "coder_report_required" ? ["REPORT GATE: the current passed artifact has no complete durable Coder report. Call report_done for this artifact before respond_to_review. If a draft exists, preserve its summary and supply only missing or corrected fields. Do not edit, commit, or rerun tests merely to bypass this report gate."] : []),
    ...(state.resume.phase === "coder_evidence_required" ? [`EVIDENCE RECOVERY: the previous report_done did not complete the ticket. Missing criterion evidence: ${(state.resume.pending_criterion_ids ?? []).join(", ")}. Preserve the existing changes and report summary, run the required checks from the approved verification plan, and retry report_done. Do not repeat completed edits or commits merely to restart the ticket. Stop only after report_done succeeds; do not resume Reviewer or claim completion with pending evidence.`] : []),
    ...(Array.isArray(state.resume.review_findings) && state.resume.review_findings.length ? ["Reviewer requested a revision of this same ticket. Address these findings:", ...currentReviewFindings(state.resume.review_findings).map((finding) => typeof finding === "string" ? `- ${finding}` : `- ${JSON.stringify(finding)}`), reviewRepairInstructions()] : []),
    ...(state.resume.repair_implementation_required ? [state.resume.repair_implementation_required.instruction] : []),
    "",
    prompt
  ].join("\n");
}

// summarizeTarget - picks the stable address (path/symbol/query) of a tool call.
function summarizeTarget(name, input) {
  if (!input || typeof input !== "object") return "";
  const raw = input.path ?? input.query ?? input.symbol ?? input.message ?? input.job_id ?? "";
  const text = String(raw ?? "").slice(0, 160);
  if (name === "search_code" && input.query) return `"${text}"`;
  return text;
}

// summarizeOutcome - one short status phrase; never embeds file contents.
function summarizeOutcome(result) {
  if (!result || typeof result !== "object") return "ok";
  if (result.error_code) return `failed: ${result.error_code}`;
  if (result.ok === false || result.status === "failed") return "failed";
  if (typeof result.total_lines === "number") return `read ok (${result.total_lines} lines)`;
  if (typeof result.summary === "string" && result.summary) return result.summary.slice(0, 120);
  return "ok";
}
