// Summary: Resolves up to eight Code Graph candidates from an Agent search intent.

import { ConfigurationError } from "../../shared/errors.js";
import { registerCandidateSources, candidateSourceMetadata } from "./candidate-source-receipts.js";
import { loadProjectKnowledge, fingerprintQuery, rerankCandidates } from "../../modules/index/semantic-knowledge.js";
import { syncToolResultToEvidenceStore } from "./subagent-evidence-sync.js";
import { assertDelegatedDiscoveryRequired } from "./delegated-discovery-policy.js";
import { assertExecutionScope } from "../governance/retrieval-governance.js";
import { discoveryNotice } from "./exploration-state.js";
import { extractExplicitPaths, isLegacyBackfillCandidate } from "../../modules/index/ticket-scope.js";
import { assertExecutionFileAccess, executionReadScope } from "../execution-file-access.js";
import { isAgentPathAllowed } from "../governance/tool-authorization.js";

export function createSelectCodeGraphCandidatesTool({ relevantTreeSelector, freshnessChecker, fileService, codeCache, assertReadPath, evidenceStore, projectRoot, logger = console, reuseTicketCandidates = true } = {}) {
  return Object.freeze({ name: "select_code_graph_candidates", execute });

  async function execute(input = {}, context = {}) {
    assertDelegatedDiscoveryRequired(context, "select_code_graph_candidates", input);
    assertExecutionFileAccess(context);
    const taskId = context.task_id ?? context.taskId ?? context.conversation_id;
    if (typeof taskId !== "string" || !taskId) throw scopedError("TOOL_SCOPE_INVALID", "Candidate selection requires the current task or conversation identity.");
    assertExecutionScope(context, taskId);
    if (Object.keys(input).some((key) => !["query", "limit", "context", "title", "objective", "acceptance_criteria", "guardrails"].includes(key))) throw scopedError("TOOL_INPUT_INVALID", "Candidate input cannot supply paths, identity or execution authority.");
    if (!new Set(context.capabilities ?? []).has("select_code_graph_candidates")) throw scopedError("TOOL_FORBIDDEN", "Agent is not authorized to select Code Graph candidates.");
    const query = input.query === undefined ? [input.title, input.objective].filter((value) => typeof value === "string").join(" ").trim() : typeof input.query === "string" ? input.query.trim() : "";
    if (!query) throw scopedError("GRAPH_QUERY_REQUIRED", "Candidate retrieval requires a non-empty query.");
    const limit = input.limit === undefined ? 8 : input.limit;
    const maximum = context.eval_harness === true ? 30 : 8;
    if (!Number.isInteger(limit) || limit < 1 || limit > maximum) throw scopedError("GRAPH_CANDIDATE_LIMIT", `Candidate retrieval limit must be between one and ${maximum}.`);
    if (typeof relevantTreeSelector?.selectFreshWithEmbeddings !== "function" && typeof relevantTreeSelector?.select !== "function") throw scopedError("GRAPH_INDEX_UNAVAILABLE", "Code Graph retrieval is not configured.");
    const task = { title: input.title, objective: input.objective, acceptance_criteria: input.acceptance_criteria, guardrails: input.guardrails, ...(context.task_context ?? {}), ...(!reuseTicketCandidates ? { candidate_files: [] } : {}) };
    const allowCandidate = (path) => typeof path === "string" && !path.startsWith("/") && !path.split("/").some((part) => !part || part === "." || part === "..")
      && isAgentPathAllowed(path, context) && (context.file_access_version === 2
        || (!Array.isArray(context.allowed_file_paths) && !Array.isArray(context.allowed_prefixes))
        || context.allowed_file_paths?.includes(path)
        || context.allowed_prefixes?.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(`${prefix.replace(/\/$/, "")}/`)));
    // Sprint-leader cache: a ticket that already carries manually-traced
    // candidate_files is served directly instead of re-running retrieval.
    // Stale entries (file no longer indexed) fall through to normal retrieval.
    const cached = reuseTicketCandidates === true ? await cachedTicketCandidates(task, limit, freshnessChecker, allowCandidate) : null;
    if (cached) {
      assertExecutionFileAccess(context);
      return { task_id: taskId, query: query, index_version: cached.index_version ?? null, selected: await receive(cached.selected, context, allowCandidate, input), candidate_source: "ticket", ...(cached.freshness ? { freshness: cached.freshness } : {}), ...(cached.stale_paths?.length ? { stale_paths: cached.stale_paths, freshness_note: "Stale candidates are flagged, not removed — read the file live and verify before editing." } : {}), discovery_budget: discoveryNotice(context) };
    }
    const allowedPrefixes = context.file_access_version === 2 ? executionReadScope(context).prefixes : context.allowed_prefixes;
    const args = context.eval_harness === true
      ? { title: task.title ?? "", objective: task.objective ?? "", acceptance_criteria: task.acceptance_criteria ?? [], guardrails: task.guardrails ?? [], style: task.implementation_type ?? task.style, limit, depth: 1 }
      : { title: task.title ?? "", objective: [task.objective ?? "", query, input.context ?? ""].filter(Boolean).join(" "), acceptance_criteria: task.acceptance_criteria ?? [], guardrails: task.guardrails ?? [], style: task.implementation_type ?? task.style, limit, scope: context.scope ?? "all", allowed_prefixes: allowedPrefixes, priorFiles: extractExplicitPaths(task).filter(allowCandidate), dependencyFiles: (Array.isArray(task.dependency_files) ? task.dependency_files : []).filter(allowCandidate) };
    // Prefer semantic retrieval with freshness validation; fall back for older test doubles.
    const result = typeof relevantTreeSelector.selectFreshWithEmbeddings === "function"
      ? await relevantTreeSelector.selectFreshWithEmbeddings(args)
      : await relevantTreeSelector.select(args);
    assertExecutionFileAccess(context);
    const selected = (result.tree ?? []).filter((entry) => allowCandidate(entry?.path)).slice(0, limit);
    const stalePaths = Array.isArray(result.stale_paths) ? result.stale_paths.filter(allowCandidate) : undefined;
    return { task_id: taskId, query: query, index_version: result.index_version ?? null, selected: await receive(selected.map((entry) => stalePaths?.includes(entry.path) ? { ...entry, stale: true } : entry), context, allowCandidate, input), ...(result.freshness ? { freshness: result.freshness } : {}), ...(stalePaths?.length ? { stale_paths: stalePaths, freshness_note: "Stale candidates are flagged, not removed — read the file live and verify before editing." } : {}), discovery_budget: discoveryNotice(context) };
  }
  // Business purpose: keeps receipt registration and durable evidence reporting consistent across both retrieval sources.
  // Technical description: validates live metadata first, then synchronizes only privately verified entries to the scoped evidence store.
  async function receive(selected, context, allowCandidate, queryInput) {
    const entries = await registerCandidateSources(selected, context, { fileService, codeCache, assertReadPath, allowPath: allowCandidate, logger });
    assertExecutionFileAccess(context);
    const authorized = entries.filter((entry) => allowCandidate(entry.path));
    // Knowledge is subordinate to source, scope and receipt gates; it never adds candidates.
    let ranked = authorized;
    if (projectRoot && context.project_id && (context.review_commit_sha ?? context.source_revision)) {
      try {
        const knowledge = await loadProjectKnowledge({ projectRoot, projectId: context.project_id,
          sourceRevision: context.review_commit_sha ?? context.source_revision, logger,
          sourceReader: async (path) => {
            const entry = authorized.find((item) => item.path === path);
            return entry ? candidateSourceMetadata(entry, context) : null;
          } });
        ranked = rerankCandidates(authorized, knowledge, { queryFingerprint: fingerprintQuery(queryInput), projectId: context.project_id,
          receiptValidator: (entry) => candidateSourceMetadata(entry, context) });
      } catch (error) { logger.warn?.("Semantic knowledge unavailable; preserving baseline candidates.", { error: error.message }); }
    }
    assertExecutionFileAccess(context);
    ranked = ranked.filter((entry) => allowCandidate(entry.path));
    syncToolResultToEvidenceStore({ toolName: "select_code_graph_candidates", result: { selected: ranked }, context, evidenceStore, projectRoot });
    return ranked;
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
async function cachedTicketCandidates(task, limit, freshnessChecker, allowCandidate = () => true) {
  const files = task?.candidate_files;
  if (!Array.isArray(files) || !files.length) return null;
  const selected = [];
  for (const entry of sortTicketCandidates(files).slice(0, limit)) {
    if (!entry || typeof entry.path !== "string" || !entry.path) continue;
    if (isLegacyBackfillCandidate(entry) || !allowCandidate(entry.path)) continue;
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
