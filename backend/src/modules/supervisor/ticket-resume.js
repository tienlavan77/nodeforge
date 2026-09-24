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
    emptyCommitSeen: clean?.empty_commit_seen === true,
    readCache: sanitizeReadCache(clean?.read_cache),
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
    empty_commit_seen: state.emptyCommitSeen === true,
    read_cache: snapshotReadCache(state),
    ...extra
  };
}

// checkpointedRegistry - wraps the governed Forge tool registry so after every
// successful tool call progress is durably checkpointed. Session identity,
// compact turn history, and changed paths survive in the shared resume state,
// so a later RUN continues the previous execution instead of restarting blind.
// Turn counting starts from the seeded checkpoint, keeping max_turns and the
// discovery budget valid across crashes.
export function checkpointedRegistry({ store, registry, taskId, targetPath, allowedPrefixes, complexity, selected, correlationId, resumeState = null, labMode = false }) {
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
        let result;
        try {
          if (name === "report_done") assertCommitBeforeReport(state, context, labMode);
          if (name === "read_file") assertReadNotRepeated(state, input);
          result = await tool.execute(input, context);
          if (name === "read_file") rememberRead(state, input, result);
          if (name === "write_diff" || name === "edit_diff") forgetRead(state, input);
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

// sanitizeReadCache - rebuilds a safe read cache from a checkpoint snapshot.
// Only compact metadata is kept (path key, sha, sizes); content is dropped so
// checkpoints stay small and never carry file bodies. Corrupt entries are skipped.
function sanitizeReadCache(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
  const clean = {};
  for (const [key, entry] of Object.entries(snapshot)) {
    if (typeof key !== "string" || !key || !entry || typeof entry !== "object") continue;
    const path = typeof entry.path === "string" ? entry.path : key.split("#")[0];
    if (!path) continue;
    clean[key] = {
      path,
      ...(typeof entry.sha256 === "string" ? { sha256: entry.sha256 } : {}),
      ...(Number.isInteger(entry.total_lines) ? { total_lines: entry.total_lines } : {}),
      ...(Number.isInteger(entry.size_bytes) ? { size_bytes: entry.size_bytes } : {}),
      ...(Number.isInteger(entry.offset) ? { offset: entry.offset } : {}),
      ...(Number.isInteger(entry.limit) ? { limit: entry.limit } : {})
    };
  }
  return clean;
}

// snapshotReadCache - compacts run-state reads for checkpoint persistence.
function snapshotReadCache(state) {
  return sanitizeReadCache(state.readCache);
}

// readCacheKey - stable address of a read: path plus window, if any.
function readCacheKey(input) {
  const path = typeof input?.path === "string" ? input.path : "";
  const offset = Number.isInteger(input?.offset) ? input.offset : 0;
  const limit = Number.isInteger(input?.limit) ? input.limit : 0;
  return `${path}#${offset}:${limit}`;
}

// assertReadNotRepeated - refuses a read_file that repeats a cached path+window.
// The sha256 returned by read_file doubles as edit before_checksum, so the
// agent already holds everything it needs: content, checksum, and symbol map.
// A repeat read with the same path and window burns a turn and a full file of
// tokens for zero new information (observed: 7 reads of one file in 12 turns).
// Any write_diff or edit_diff invalidates the path, forcing a genuine fresh read.
function assertReadNotRepeated(state, input) {
  const path = typeof input?.path === "string" ? input.path : "";
  if (!path) return;
  const cached = state.readCache?.[readCacheKey(input)];
  if (!cached) return;
  throw Object.assign(new ConfigurationError(`Repeat read refused: ${path} with this window is unchanged since your earlier read (sha ${String(cached.sha256 ?? "").slice(0, 12)}). Reuse the content and sha256 you already have; do not call read_file again for it. If you edited the file since, that read is already invalidated — otherwise move on to edit_diff, write_diff, run_test, commit_changes, or report_done.`), { code: "READ_REPEATED", tool: "read_file" });
}

// rememberRead - caches a successful read result for repeat-read serving.
function rememberRead(state, input, result) {
  if (!result || typeof result !== "object" || typeof result.content !== "string") return;
  if (!state.readCache || typeof state.readCache !== "object") state.readCache = {};
  state.readCache[readCacheKey(input)] = result;
}

// forgetRead - drops cached reads of a path after it is written or edited.
function forgetRead(state, input) {
  const path = typeof input?.path === "string" ? input.path : "";
  if (!path || !state.readCache) return;
  for (const key of Object.keys(state.readCache)) {
    if (key === path || key.startsWith(`${path}#`)) delete state.readCache[key];
  }
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
