// Summary: Resolves up to eight Code Graph candidates from an Agent search intent.

import { ConfigurationError } from "../shared/errors.js";
import { assertExecutionScope } from "./retrieval-governance.js";
import { discoveryNotice } from "./exploration-state.js";
import { extractExplicitPaths, isLegacyBackfillCandidate } from "../modules/index/ticket-scope.js";

export function createSelectCodeGraphCandidatesTool({ relevantTreeSelector, freshnessChecker } = {}) {
  return Object.freeze({ name: "select_code_graph_candidates", execute });

  async function execute(input = {}, context = {}) {
    const taskId = context.task_id ?? context.taskId;
    if (typeof taskId !== "string" || !taskId) throw scopedError("TOOL_SCOPE_INVALID", "Candidate selection requires the current task_id.");
    assertExecutionScope(context, taskId);
    if (!new Set(context.capabilities ?? []).has("select_code_graph_candidates")) throw scopedError("TOOL_FORBIDDEN", "Agent is not authorized to select Code Graph candidates.");
    if (typeof input.query !== "string" || !input.query.trim()) throw scopedError("GRAPH_QUERY_REQUIRED", "Candidate retrieval requires a non-empty query.");
    const limit = input.limit === undefined ? 8 : input.limit;
    const maximum = context.eval_harness === true ? 30 : 8;
    if (!Number.isInteger(limit) || limit < 1 || limit > maximum) throw scopedError("GRAPH_CANDIDATE_LIMIT", `Candidate retrieval limit must be between one and ${maximum}.`);
    if (typeof relevantTreeSelector?.selectFreshWithEmbeddings !== "function" && typeof relevantTreeSelector?.select !== "function") throw scopedError("GRAPH_INDEX_UNAVAILABLE", "Code Graph retrieval is not configured.");
    const task = context.task_context ?? {};
    // Sprint-leader cache: a ticket that already carries manually-traced
    // candidate_files is served directly instead of re-running retrieval.
    // Stale entries (file no longer indexed) fall through to normal retrieval.
    const cached = await cachedTicketCandidates(task, limit, freshnessChecker);
    if (cached) return { task_id: taskId, query: input.query.trim(), index_version: cached.index_version ?? null, selected: cached.selected, candidate_source: "ticket", ...(cached.freshness ? { freshness: cached.freshness } : {}), ...(cached.stale_paths?.length ? { stale_paths: cached.stale_paths, freshness_note: "Stale candidates are flagged, not removed — read the file live and verify before editing." } : {}), discovery_budget: discoveryNotice(context) };
    const args = context.eval_harness === true
      ? { title: task.title ?? "", objective: task.objective ?? "", acceptance_criteria: task.acceptance_criteria ?? [], style: task.style, limit, depth: 1 }
      : { title: task.title ?? "", objective: [task.objective ?? "", input.query.trim(), input.context ?? ""].filter(Boolean).join(" "), acceptance_criteria: task.acceptance_criteria ?? [], style: task.style, limit, scope: context.scope ?? "all", allowed_prefixes: context.allowed_prefixes, priorFiles: extractExplicitPaths(task), dependencyFiles: Array.isArray(task.dependency_files) ? task.dependency_files : [] };
    // Prefer semantic retrieval with freshness validation; fall back for older test doubles.
    const result = typeof relevantTreeSelector.selectFreshWithEmbeddings === "function"
      ? await relevantTreeSelector.selectFreshWithEmbeddings(args)
      : relevantTreeSelector.select(args);
    return { task_id: taskId, query: input.query.trim(), index_version: result.index_version ?? null, selected: result.tree.slice(0, limit), ...(result.freshness ? { freshness: result.freshness } : {}), ...(result.stale_paths?.length ? { stale_paths: result.stale_paths, freshness_note: "Stale candidates are flagged, not removed — read the file live and verify before editing." } : {}), discovery_budget: discoveryNotice(context) };
  }
}

function scopedError(code, message) { const error = new ConfigurationError(message); error.code = code; return error; }

// Serves sprint-leader-traced candidates stored on the ticket. Returns null
// when the ticket carries none, so the caller falls back to live retrieval.
// Only path/role/reason metadata is served — never file content. PATCH entries
// sort first so the first call always contains the files to edit.
// Staleness (renamed/deleted files) is caught downstream: the builder must
// read_file each PATCH/REUSE path before editing, and a missing file errors
// at read time, at which point the builder re-discovers via search_code.
async function cachedTicketCandidates(task, limit, freshnessChecker) {
  const files = task?.candidate_files;
  if (!Array.isArray(files) || !files.length) return null;
  const selected = [];
  for (const entry of sortTicketCandidates(files).slice(0, limit)) {
    if (!entry || typeof entry.path !== "string" || !entry.path) continue;
    if (isLegacyBackfillCandidate(entry)) continue;
    selected.push({ path: entry.path, score: 0, reason: [`ticket:${entry.role ?? "REFERENCE"}`, entry.symbol ? `symbol:${entry.symbol}` : "", entry.reason ?? ""].filter(Boolean), ...(entry.symbol ? { symbol: entry.symbol } : {}), relations: [], node: { path: entry.path }, confidence: "ticket-traced" });
  }
  if (!selected.length) return null;
  if (!freshnessChecker || typeof freshnessChecker.checkPaths !== "function") return { selected, index_version: undefined };
  const verdicts = await freshnessChecker.checkPaths(selected.map((entry) => entry.path));
  const byPath = new Map(verdicts.map((verdict) => [verdict.path, verdict.status]));
  const stalePaths = [];
  const counts = { checked: selected.length, fresh: 0, stale: 0, missing: 0, unreadable: 0 };
  const checked = selected.map((entry) => {
    const status = byPath.get(entry.path) ?? "unreadable";
    counts[status] = (counts[status] ?? 0) + 1;
    if (status !== "fresh") {
      stalePaths.push(entry.path);
      return { ...entry, stale: true, reason: [...entry.reason, `stale:index-${status}-needs-verify`] };
    }
    return entry;
  });
  return { selected: checked, index_version: undefined, freshness: counts, stale_paths: stalePaths };
}

// PATCH files first so a single default call surfaces every edit target
// even on mixed backend+frontend tickets; stable order otherwise.
function sortTicketCandidates(files) {
  const rank = (role) => role === "PATCH" ? 0 : role === "REUSE" ? 1 : role === "REFERENCE" ? 2 : 3;
  return [...files].sort((a, b) => rank(a?.role) - rank(b?.role));
}
