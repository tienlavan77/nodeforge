// Resume context for crash recovery — keeps provider session identity, per-turn
// history, and remaining budget across RUNs so a resumed ticket continues the
// previous execution instead of restarting blind. Only compact turn summaries
// are persisted; file contents never go through the checkpoint.
import { ConfigurationError } from "../../shared/errors.js";

const MAX_HISTORY_TURNS = 12;

// normalizeResume - returns a safe resume snapshot or null when unusable.
export function normalizeResume(resume) {
  if (!resume || typeof resume !== "object") return null;
  if (resume.status === "completed") return null;
  return resume;
}

// createResumeState - mutable per-run state seeded from a prior checkpoint.
export function createResumeState(resume, complexity) {
  const clean = normalizeResume(resume);
  const maxTurns = Number.isInteger(complexity?.max_turns) && complexity.max_turns > 0 ? complexity.max_turns : null;
  return {
    resume: clean,
    sessionId: typeof clean?.session_id === "string" ? clean.session_id : null,
    threadId: typeof clean?.thread_id === "string" ? clean.thread_id : null,
    turnCount: Number.isInteger(clean?.last_completed_turn) ? clean.last_completed_turn : 0,
    completedTools: Array.isArray(clean?.completed_tools) ? [...clean.completed_tools] : [],
    turnHistory: Array.isArray(clean?.turn_history) ? [...clean.turn_history] : [],
    changedPaths: Array.isArray(clean?.changed_paths) ? [...clean.changed_paths] : [],
    maxTurns
  };
}

// remainingTurns - turns left before the wall-clock/turn budget is exhausted.
export function remainingTurns(state) {
  if (!state || state.maxTurns === null) return null;
  return Math.max(state.maxTurns - state.turnCount, 0);
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
    ...extra
  };
}

// checkpointedRegistry - wraps the governed Forge tool registry so after every
// successful tool call progress is durably checkpointed. Session identity,
// compact turn history, and changed paths survive in the shared resume state,
// so a later RUN continues the previous execution instead of restarting blind.
// Turn counting starts from the seeded checkpoint, keeping max_turns and the
// discovery budget valid across crashes.
export function checkpointedRegistry({ store, registry, taskId, targetPath, allowedPrefixes, complexity, selected, correlationId, resumeState = null }) {
  if (!store || !registry) return registry;
  const state = resumeState ?? createResumeState(null, complexity);
  const wrapped = {};
  for (const [name, tool] of Object.entries(registry)) {
    if (typeof tool?.execute !== "function") { wrapped[name] = tool; continue; }
    wrapped[name] = Object.freeze({
      ...tool,
      async execute(input, context) {
        const remaining = remainingTurns(state);
        if (remaining !== null && remaining <= 0 && name !== "report_done") {
          throw Object.assign(new ConfigurationError(`Turn limit reached (${state.turnCount}/${state.maxTurns}). The ONLY remaining allowed tool is report_done; use it to summarize the work performed so far, then stop.`), { code: "MAX_TURNS_EXCEEDED" });
        }
        const result = await tool.execute(input, context);
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
          last_tool: name,
          changed_paths: changedSnapshot,
          status: done ? "completed" : "in_progress",
          ...(done ? { completed_at: new Date().toISOString() } : {})
        });
        if (done) await store.complete(taskId, payload).catch(() => {});
        else await store.save(payload).catch(() => {});
        return result;
      }
    });
  }
  return wrapped;
}

// failureDetail - compact gateway/crash error for the failure-path checkpoint.
export function failureDetail(error) {
  const message = typeof error?.message === "string" && error.message ? error.message : "unknown execution error";
  return { code: error?.code ?? "GATEWAY_FAILED", message: message.slice(0, 500), at: new Date().toISOString() };
}

// buildResumePrompt - prefixes the ticket prompt with compact resume context.
export function buildResumePrompt(prompt, state, meta = {}) {
  if (!state?.resume) return prompt;
  const remaining = remainingTurns(state);
  const history = state.turnHistory.length
    ? state.turnHistory.map((entry) => `- turn ${entry.turn} ${entry.tool} ${entry.target} -> ${entry.outcome}`.trim()).join("\n")
    : `Tools already completed successfully (do NOT call them again for the same inputs): ${(state.completedTools ?? []).join(", ") || "(none recorded)"}.`;
  return [
    `RESUMED RUN: a previous execution stopped after completing turn ${state.turnCount}${state.maxTurns !== null ? ` of ${state.maxTurns} (${remaining} turns remain, including the final report_done)` : ""}.`,
    state.sessionId ? "Provider session resumed; earlier assistant context may be available, but the worktree is the source of truth." : "No provider session survived; the worktree below is the source of truth.",
    "Completed turns (do NOT repeat these tool calls with the same inputs):",
    history,
    `Files already changed in the worktree: ${[...new Set([...state.changedPaths, ...(meta.changedPaths ?? [])])].join(", ") || "(none)"} — verify with read_file if needed, then continue with the next unfinished step.`,
    `Previous agent: ${meta.agentId ?? state.resume.agent_id ?? "unknown"} (${meta.provider ?? state.resume.provider ?? "unknown provider"}).`,
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
