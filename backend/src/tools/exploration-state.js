// Summary: Tracks exploration productivity so stagnant or unbounded discovery is refused mechanically.

import { ConfigurationError } from "../shared/errors.js";

export const EXPLORATION_STREAK_LIMIT = 3;
export const DISCOVERY_LIMIT = 8;
// A productive agent gets exactly one budget extension (+50%), so a
// mis-classified "simple" ticket is not killed mid-flight; an agent that is
// already looping unproductively is refused immediately.
export const ESCALATION_FACTOR = 0.5;

export function createExplorationState() {
  return { seen_queries: [], seen_paths: [], seen_reads: [], unproductive_streak: 0, discovery_count: 0, edit_started: false, discovery_limit: DISCOVERY_LIMIT, escalations: 0 };
}

export function cloneExplorationState(state) {
  if (!state || typeof state !== "object") return createExplorationState();
  return {
    seen_queries: [...(state.seen_queries ?? [])],
    seen_paths: [...(state.seen_paths ?? [])],
    seen_reads: [...(state.seen_reads ?? [])],
    unproductive_streak: Number.isInteger(state.unproductive_streak) ? state.unproductive_streak : 0,
    discovery_count: Number.isInteger(state.discovery_count) ? state.discovery_count : 0,
    edit_started: state.edit_started === true,
    discovery_limit: Number.isInteger(state.discovery_limit) ? state.discovery_limit : DISCOVERY_LIMIT,
    escalations: Number.isInteger(state.escalations) ? state.escalations : 0
  };
}

export function resetExploration(context) {
  const state = explorationState(context);
  if (state) state.unproductive_streak = 0;
}

// A search is productive when it surfaces at least one path the agent has not
// seen before; otherwise it counts toward the stagnation streak. Only the
// streak is capped — a long task that keeps discovering new files runs freely.
export function recordSearch(context, { query, topPaths = [] } = {}) {
  const state = explorationState(context);
  if (!state) return;
  const normalized = typeof query === "string" ? query.toLowerCase().trim() : "";
  const paths = (Array.isArray(topPaths) ? topPaths : []).filter((path) => typeof path === "string" && path);
  const productive = paths.length > 0
    && !state.seen_queries.includes(normalized)
    && paths.some((path) => !state.seen_paths.includes(path));
  if (productive) {
    state.unproductive_streak = 0;
    if (!state.seen_queries.includes(normalized)) state.seen_queries.push(normalized);
    for (const path of paths) if (!state.seen_paths.includes(path)) state.seen_paths.push(path);
    return;
  }
  countUnproductive(state);
}

export function recordRead(context, { path, window = "full" } = {}) {
  const state = explorationState(context);
  if (!state) return;
  const key = `${path}#${window}`;
  if (state.seen_reads.includes(key)) {
    countUnproductive(state);
    return;
  }
  state.seen_reads.push(key);
  state.unproductive_streak = 0;
}

// Phase gate: discovery tools (graph/search/read) are capped before the first
// edit because each SDK round-trip burns wall-clock time even when the call
// returns new information ("productive procrastination"). Once an edit lands,
// the gate stays open for verification reads.
export function assertDiscoveryBudget(context) {
  const state = explorationState(context);
  if (!state) return;
  const limit = Number.isInteger(state.discovery_limit) && state.discovery_limit > 0 ? state.discovery_limit : DISCOVERY_LIMIT;
  if (!state.edit_started && state.discovery_count >= limit) {
    // One soft extension for a still-productive agent (no unproductive calls
    // in a row); a looping agent is refused without escalation.
    if (state.escalations < 1 && state.unproductive_streak === 0) {
      state.escalations += 1;
      state.discovery_limit = limit + Math.ceil(limit * ESCALATION_FACTOR);
      return;
    }
    throw Object.assign(new ConfigurationError(`Discovery budget exhausted after ${limit} exploration calls. Your ONLY next action is edit_diff or write_diff. Do not call search_code, read_file, or select_code_graph_candidates again.`), { code: "EXPLORATION_BUDGET_EXHAUSTED" });
  }
  state.discovery_count += 1;
}

export function markEditStarted(context) {
  const state = explorationState(context);
  if (state) state.edit_started = true;
}

export function discoveryCount(context) {
  const state = explorationState(context);
  if (!state) return { used: 0, remaining: null, limit: DISCOVERY_LIMIT, edit_started: true };
  const limit = Number.isInteger(state.discovery_limit) && state.discovery_limit > 0 ? state.discovery_limit : DISCOVERY_LIMIT;
  return { used: state.discovery_count, remaining: state.edit_started ? null : Math.max(0, limit - state.discovery_count), limit, edit_started: state.edit_started };
}

function countUnproductive(state) {
  state.unproductive_streak += 1;
  if (state.unproductive_streak >= EXPLORATION_STREAK_LIMIT) {
    throw Object.assign(new ConfigurationError(`${EXPLORATION_STREAK_LIMIT} consecutive exploration calls produced no new information. Stop exploring: use edit_diff/write_diff with what you have, or select_code_graph_candidates for a different angle.`), { code: "EXPLORATION_STAGNANT" });
  }
}

function explorationState(context) {
  if (!context || typeof context !== "object") return undefined;
  if (!context.exploration_state || typeof context.exploration_state !== "object") context.exploration_state = createExplorationState();
  return context.exploration_state;
}
