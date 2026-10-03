// Resume context for crash recovery — keeps provider session identity, per-turn
// history across RUNs so a resumed ticket continues the
// previous execution instead of restarting blind. Only compact turn summaries
// are persisted; file contents never go through the checkpoint.
import { ConfigurationError } from "../../shared/errors.js";
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
    sessionId: typeof clean?.session_id === "string" ? clean.session_id : null,
    threadId: typeof clean?.thread_id === "string" ? clean.thread_id : null,
    turnCount: Number.isInteger(clean?.last_completed_turn) ? clean.last_completed_turn : 0,
    completedTools: Array.isArray(clean?.completed_tools) ? [...clean.completed_tools] : [],
    turnHistory: Array.isArray(clean?.turn_history) ? [...clean.turn_history] : [],
    changedPaths: Array.isArray(clean?.changed_paths) ? [...clean.changed_paths] : [],
    emptyCommitSeen: clean?.empty_commit_seen === true,
    readCache: sanitizeReadCache(clean?.read_cache),
    coderRulesRead: clean?.coder_rules_read === true || Object.keys(clean?.read_cache ?? {}).some((key) => key.startsWith("workflows/agents/coder/README.md#"))
  };
}

// recordTurn - appends a compact turn entry; returns the entry for checkpointing.
export function recordTurn(state, name, input, result) {
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
  return {
    ...(state.resume ?? {}),
    session_id: state.sessionId ?? state.resume?.session_id ?? null,
    thread_id: state.threadId ?? state.resume?.thread_id ?? null,
    last_completed_turn: state.turnCount,
    completed_tools: [...state.completedTools],
    turn_history: [...state.turnHistory],
    empty_commit_seen: state.emptyCommitSeen === true,
    read_cache: snapshotReadCache(state.readCache),
    coder_rules_read: state.coderRulesRead === true,
    ...extra
  };
}

// checkpointedRegistry - wraps the governed Forge tool registry so after every
// successful tool call progress is durably checkpointed. Session identity,
// compact turn history, and changed paths survive in the shared resume state,
// so a later RUN continues the previous execution instead of restarting blind.
// Turn counting starts from the seeded checkpoint for accurate progress.
export function checkpointedRegistry({ store, registry, taskId, targetPath, allowedPrefixes, complexity, selected, correlationId, resumeState = null, labMode = false }) {
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
          if (name === "report_done") assertCommitBeforeReport(state, context, labMode);
          if (name === "read_file") assertReadNotRepeated(state.readCache, input);
          result = await tool.execute(input, context);
          if (selected?.role === "coder" && ["read_file", "Read", "sed_lines"].includes(name) && (input?.path === "workflows/agents/coder/README.md" || input?.file_path === "workflows/agents/coder/README.md" || input?.file_path?.endsWith("/workflows/agents/coder/README.md")) && (name === "sed_lines" ? result?.exit_code === 0 : typeof result?.content === "string")) state.coderRulesRead = true;
          if (name === "read_file") rememberRead(state.readCache, input, result);
          if (name === "write_diff" || name === "edit_diff") forgetRead(state.readCache, input);
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
function assertCommitBeforeReport(state, context, labMode) {
  if (labMode || context?.lab_mode || context?.labMode) return;
  if (state.emptyCommitSeen) return;
  if (state.changedPaths.length === 0) return;
  const tools = state.completedTools;
  const lastEdit = Math.max(tools.lastIndexOf("write_diff"), tools.lastIndexOf("edit_diff"));
  const lastCommit = tools.lastIndexOf("commit_changes");
  if (lastCommit === -1 || (lastEdit !== -1 && lastEdit > lastCommit)) {
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
  const history = state.turnHistory.length
    ? state.turnHistory.map((entry) => `- turn ${entry.turn} ${entry.tool} ${entry.target} -> ${entry.outcome}`.trim()).join("\n")
    : `Tools already completed successfully (do NOT call them again for the same inputs): ${(state.completedTools ?? []).join(", ") || "(none recorded)"}.`;
  return [
    `RESUMED RUN: a previous execution stopped after completing turn ${state.turnCount}.`,
    state.sessionId ? "Provider session resumed; earlier assistant context may be available, but the worktree is the source of truth." : "No provider session survived; the worktree below is the source of truth.",
    "Completed turns (do NOT repeat these tool calls with the same inputs):",
    history,
    `Files already changed in the worktree: ${[...new Set([...state.changedPaths, ...(meta.changedPaths ?? [])])].join(", ") || "(none)"} — verify with read_file if needed, then continue with the next unfinished step.`,
    `Previous agent: ${meta.agentId ?? state.resume.agent_id ?? "unknown"} (${meta.provider ?? state.resume.provider ?? "unknown provider"}).`,
    ...(state.resume.phase === "coder_report_required" ? ["REPORT GATE: the current passed artifact has no complete durable Coder report. Call report_done for this artifact before respond_to_review. If a draft exists, preserve its summary and supply only missing or corrected fields. Do not edit, commit, or rerun tests merely to bypass this report gate."] : []),
    ...(Array.isArray(state.resume.review_findings) && state.resume.review_findings.length ? ["Reviewer requested a revision of this same ticket. Address these findings:", ...state.resume.review_findings.map((finding) => typeof finding === "string" ? `- ${finding}` : `- ${finding.finding_id}: ${finding.message}`), "You may use respond_to_review to accept or dispute each finding against the current passed artifact, without editing code. If code repair is needed, commit a revision, verify it, and submit a new report_done explanation. Never claim a finding is closed; only Reviewer adjudication can close it."] : []),
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
