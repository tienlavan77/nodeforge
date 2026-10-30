// Summary: Enforces productive repository discovery before an agent edits code.

import { ConfigurationError } from "../../shared/errors.js";
import {
  DISCOVERY_LIMIT,
  ESCALATION_FACTOR,
  EXPLORATION_STREAK_LIMIT,
  cloneExplorationState,
  createExplorationState,
  discoveryKind,
  DISCOVERY_KINDS
} from "./exploration-state-factory.js";

export {
  DISCOVERY_LIMIT,
  ESCALATION_FACTOR,
  EXPLORATION_STREAK_LIMIT,
  cloneExplorationState,
  createExplorationState,
  discoveryKind,
  DISCOVERY_KINDS
};

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
    if (state.explicit_target && paths.includes(state.explicit_target)) state.target_read = true;
    return;
  }
  countUnproductive(state);
}

export function recordRead(context, { path, window = "full" } = {}) {
  const state = explorationState(context);
  if (!state) return;
  const key = `${path}#${window}`;
  if (state.explicit_target && path === state.explicit_target) state.target_read = true;
  if (state.seen_reads.includes(key)) {
    countUnproductive(state);
    return;
  }
  state.seen_reads.push(key);
  state.unproductive_streak = 0;
}

// Phase gate: discovery tools (graph/search/read) are bounded before the first
// edit by a single mandatory resource ceiling — the total discovery budget. The
// former per-type caps (2.3), pre-edit deadline (2.11) and explicit-target
// candidate bypass (2.4) are method-shaping guidance, not authoritative
// constraints: a Coder may keep discovering within the boundary it was granted,
// so crossing a per-type cap or the pre-edit marker no longer throws. Those
// boundaries now surface as advisory hints via discoveryNotice, which keeps
// reporting by_type usage, the pre-edit marker and a suggested next action so
// the agent still receives the steering without losing autonomy. The total
// budget, its one-time escalation, and stagnation remain hard resource/loop
// guards. Once an edit lands the gate stays open for verification reads.
export function assertDiscoveryBudget(context, kind = null) {
  const state = explorationState(context);
  if (!state) return;
  const limit = Number.isInteger(state.discovery_limit) && state.discovery_limit > 0 ? state.discovery_limit : DISCOVERY_LIMIT;

  // Post-edit: the gate is open. Keep bookkeeping counts in sync but enforce
  // nothing, so verification reads/searches are never blocked.
  if (state.edit_started) {
    state.discovery_count += 1;
    bumpType(state, kind);
    return;
  }

  // Total budget with the single productive-only escalation (Gói 1). This is the
  // only resource ceiling that hard-throws; per-type caps and the pre-edit
  // marker are advisory. The boundary call that triggers escalation returns
  // without consuming a slot, so the extension grants its full extra calls
  // (matches the original semantics).
  if (state.discovery_count >= limit) {
    if (state.allow_escalation !== false && state.escalations < 1 && state.unproductive_streak === 0) {
      state.escalations += 1;
      state.discovery_limit = limit + Math.ceil(limit * ESCALATION_FACTOR);
      return;
    }
    throw Object.assign(new ConfigurationError(`Discovery budget exhausted after ${limit} exploration calls. Use edit_diff or write_diff if context is sufficient, or call report_done with status:"needs_context" or "blocked".`), { code: "EXPLORATION_BUDGET_EXHAUSTED" });
  }

  state.discovery_count += 1;
  bumpType(state, kind);
}

// Builds the advisory discovery notice returned alongside every discovery
// result. Per-type caps and the pre-edit marker are method guidance, not hard
// gates: when the agent reaches one, this notice steers it toward editing or a
// different discovery angle rather than the runtime throwing. The only hard
// stop remains the total budget (see assertDiscoveryBudget).
export function discoveryNotice(context) {
  // Sessions exempt from discovery quotas do not receive edit-phase or repeated-read gates.
  if (context?.exploration_enabled === false) return {
    used: 0, limit: null, remaining: null, edit_started: false, by_type: null,
    edit_must_start_by: null, target_read: false, suggested_next_action: null,
    message: "Discovery has no session quota for this tool session."
  };
  const discovery = discoveryCount(context);
  const state = context?.exploration_state;
  const by_type = state ? {
    candidate: { used: state.candidate_calls, limit: state.candidate_limit ?? null },
    search: { used: state.search_calls, limit: state.search_limit ?? null },
    read: { used: state.read_calls, limit: state.read_limit ?? null }
  } : null;
  const target_read = state?.target_read === true;
  const at_preedit_edge = !discovery.edit_started && Number.isInteger(state?.edit_must_start_by)
    && discovery.used >= state.edit_must_start_by;
  const at_type_cap = Boolean(state) && !discovery.edit_started && ["candidate", "search", "read"]
    .some((kind) => Number.isInteger(typeLimitFor(state, kind)) && typeUsedFor(state, kind) >= typeLimitFor(state, kind));
  const target_known_hint = Boolean(state?.explicit_target) && !target_read;
  const suggested_next_action =
    discovery.edit_started || discovery.remaining === null
      ? null
      : (discovery.remaining <= 2 || target_read)
        ? "edit_diff_or_write_diff"
        : (at_type_cap || at_preedit_edge || target_known_hint)
          ? "edit_diff_or_write_diff"
          : "continue_targeted_discovery";
  let message;
  if (discovery.edit_started) {
    message = "Discovery budget no longer applies after the first edit.";
  } else if (target_read) {
    message = "Target file has been read. Edit with this context; further repository discovery must be justified by a specific unseen symbol.";
  } else if (target_known_hint) {
    message = `The ticket names an explicit target (${state.explicit_target}). Reading it directly is usually faster than candidate discovery, but discovery stays available within the total budget.`;
  } else if (at_type_cap) {
    message = "One discovery tool type has reached its advisory cap; try a different discovery angle, start editing with the context you have, or continue within the total budget if a specific unseen symbol justifies it.";
  } else if (at_preedit_edge) {
    message = "You have passed the advisory edit marker. Begin edit_diff or write_diff with the context you have; further discovery is allowed but should be justified by a specific unseen symbol.";
  } else if (discovery.remaining <= 2) {
    message = "Start editing now; only targeted discovery is justified before edit.";
  } else {
    message = "Continue targeted discovery and edit once the target context is sufficient.";
  }
  return {
    used: discovery.used,
    limit: discovery.limit,
    remaining: discovery.remaining,
    edit_started: discovery.edit_started,
    by_type,
    edit_must_start_by: state?.edit_must_start_by ?? null,
    target_read,
    suggested_next_action,
    message
  };
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

function bumpType(state, kind) {
  if (kind === "candidate") state.candidate_calls += 1;
  else if (kind === "search") state.search_calls += 1;
  else if (kind === "read") state.read_calls += 1;
}

function typeLimitFor(state, kind) {
  if (kind === "candidate") return state.candidate_limit;
  if (kind === "search") return state.search_limit;
  if (kind === "read") return state.read_limit;
  return null;
}

function typeUsedFor(state, kind) {
  if (kind === "candidate") return state.candidate_calls;
  if (kind === "search") return state.search_calls;
  if (kind === "read") return state.read_calls;
  return 0;
}

function countUnproductive(state) {
  state.unproductive_streak += 1;
  if (state.unproductive_streak >= EXPLORATION_STREAK_LIMIT) {
    throw Object.assign(new ConfigurationError(`${EXPLORATION_STREAK_LIMIT} consecutive exploration calls produced no new information. Stop exploring: use edit_diff/write_diff with what you have, or select_code_graph_candidates for a different angle.`), { code: "EXPLORATION_STAGNANT" });
  }
}

function explorationState(context) {
  if (!context || typeof context !== "object") return undefined;
  if (context.exploration_enabled === false) return undefined;
  if (!context.exploration_state || typeof context.exploration_state !== "object") context.exploration_state = createExplorationState();
  return context.exploration_state;
}
