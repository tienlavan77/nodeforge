// Summary: Creates and sanitizes exploration state used to bound repository discovery.

export const EXPLORATION_STREAK_LIMIT = 3;
export const DISCOVERY_LIMIT = 8;
// A productive agent gets exactly one budget extension (+50%), so a
// mis-classified "simple" ticket is not killed mid-flight; an agent that is
// already looping unproductively is refused immediately. Tickets classified
// "simple" opt out of this extension entirely (see allow_escalation below),
// since that fallback was observed rescuing over-exploration instead of
// protecting against mis-classification.
export const ESCALATION_FACTOR = 0.5;

// Discovery kinds split the shared budget into per-tool caps so one tool type
// (observed: select_code_graph_candidates run six times) cannot consume the
// whole budget. A null cap means "unbounded by type" — the total discovery
// budget and pre-edit deadline still apply.
export const DISCOVERY_KINDS = {
  select_code_graph_candidates: "candidate",
  search_code: "search",
  rg_files: "search",
  rg_search: "search",
  read_file: "read",
  sed_lines: "read",
  read_code: "read",
  Read: "read",
  Glob: "search",
  Grep: "search"
};

// Maps a discovery tool name to its per-kind budget category.
export function discoveryKind(toolName) {
  return DISCOVERY_KINDS[toolName] ?? null;
}

// Creates the default exploration state for a supervised execution.
export function createExplorationState() {
  return {
    seen_queries: [], seen_paths: [], seen_reads: [],
    unproductive_streak: 0, discovery_count: 0, edit_started: false,
    discovery_limit: DISCOVERY_LIMIT, escalations: 0, allow_escalation: true,
    candidate_limit: null, search_limit: null, read_limit: null,
    candidate_calls: 0, search_calls: 0, read_calls: 0,
    edit_must_start_by: null,
    explicit_target: null, target_read: false
  };
}

// Clones persisted exploration state while restoring safe defaults for invalid fields.
export function cloneExplorationState(state) {
  if (!state || typeof state !== "object") return createExplorationState();
  const fallback = createExplorationState();
  return {
    seen_queries: [...(state.seen_queries ?? [])],
    seen_paths: [...(state.seen_paths ?? [])],
    seen_reads: [...(state.seen_reads ?? [])],
    unproductive_streak: Number.isInteger(state.unproductive_streak) ? state.unproductive_streak : 0,
    discovery_count: Number.isInteger(state.discovery_count) ? state.discovery_count : 0,
    edit_started: state.edit_started === true,
    discovery_limit: Number.isInteger(state.discovery_limit) ? state.discovery_limit : DISCOVERY_LIMIT,
    escalations: Number.isInteger(state.escalations) ? state.escalations : 0,
    allow_escalation: state.allow_escalation !== false,
    candidate_limit: positiveOrNull(state.candidate_limit ?? fallback.candidate_limit),
    search_limit: positiveOrNull(state.search_limit ?? fallback.search_limit),
    read_limit: positiveOrNull(state.read_limit ?? fallback.read_limit),
    candidate_calls: countOr(state.candidate_calls),
    search_calls: countOr(state.search_calls),
    read_calls: countOr(state.read_calls),
    edit_must_start_by: positiveOrNull(state.edit_must_start_by ?? fallback.edit_must_start_by),
    explicit_target: typeof state.explicit_target === "string" && state.explicit_target ? state.explicit_target : null,
    target_read: state.target_read === true
  };
}

// Normalizes optional positive integer limits and returns null for invalid values.
function positiveOrNull(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

// Normalizes non-negative counters and returns zero for invalid values.
function countOr(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
