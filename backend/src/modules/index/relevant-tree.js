import { ConfigurationError } from "../../shared/errors.js";
import { tokenizeSearchText } from "./search-vocabulary.js";

/** Select a bounded set of indexed files relevant to a natural-language task. */
export function createRelevantTreeSelector({ search, fileGraph, maxFiles = 30, defaultDepth = 1, ignoredPaths = [".git/", ".forge/runtime/", ".next/", ".next.stale-"] } = {}) {
  if (!search || typeof search.search !== "function") throw new ConfigurationError("Relevant Tree requires Code Search.");
  if (!fileGraph || typeof fileGraph.getDependencies !== "function" || typeof fileGraph.getDependents !== "function") throw new ConfigurationError("Relevant Tree requires File Graph.");
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new ConfigurationError("Relevant Tree maxFiles must be a positive integer.");
  return Object.freeze({ select });

  function select({ title = "", objective = "", acceptanceCriteria = [], acceptance_criteria = [], depth = defaultDepth, limit = maxFiles, scope = "all", allowed_prefixes, allowedPrefixes } = {}) {
    const criteria = acceptanceCriteria.length ? acceptanceCriteria : acceptance_criteria;
    const text = [title, objective, ...(Array.isArray(criteria) ? criteria : [])].filter((value) => typeof value === "string" && value.trim()).join(" ");
    if (!text) throw new ConfigurationError("Relevant Tree requires ticket title, objective, or acceptance criteria.");
    if (!Number.isInteger(depth) || depth < 0 || depth > 3) throw new ConfigurationError("Relevant Tree depth must be an integer between 0 and 3.");
    if (!Number.isInteger(limit) || limit < 1 || limit > maxFiles) throw new ConfigurationError(`Relevant Tree limit must be between 1 and ${maxFiles}.`);
    const normalizedScope = typeof scope === "string" && scope.trim() ? scope.trim() : "all";
    const normalizedAllowedPrefixes = normalizePrefixes(allowed_prefixes ?? allowedPrefixes);
    const seeds = new Map();
    const add = (entry, score, reason, relation = null) => {
      const path = entry?.node?.path ?? entry?.path;
      if (!path || isIgnored(path) || (normalizedAllowedPrefixes && !normalizedAllowedPrefixes.some((prefix) => path.startsWith(prefix)))) return;
      const current = seeds.get(path) ?? { path, score: 0, reasons: new Set(), relations: [], node: entry.node ?? entry };
      current.score = Math.max(current.score, score);
      current.reasons.add(reason);
      if (relation) current.relations.push(relation);
      seeds.set(path, current);
    };
    const terms = tokenizeSearchText(text, { minLength: 3 });
    for (const term of terms) {
      for (const match of safeSearch(term, "all", Math.min(limit, 20))) {
        add(match, Number(match.score) || 0.1, ...(match.reason?.length ? [match.reason.join(";")] : [`search:${term}`]));
        const path = match.node?.path;
        if (!path || depth === 0) continue;
        for (const relation of [...fileGraph.getDependencies(path, depth).edges, ...fileGraph.getDependents(path, depth).edges]) {
          const linked = relation.from === path ? relation.to : relation.from;
          add({ path: linked, node: { path: linked } }, (Number(match.score) || 0.1) * 0.5, `graph:${relation.kind}`, relation);
        }
      }
    }
    const matches = [...seeds.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit).map((item) => ({ path: item.path, score: Number(item.score.toFixed(4)), reason: [...item.reasons], relations: item.relations, node: item.node, confidence: "static" }));
    return Object.freeze({ query: text, scope: normalizedScope, allowed_prefixes: normalizedAllowedPrefixes ?? undefined, tree: Object.freeze(matches), index_version: matches[0]?.node?.index_version ?? undefined, limits: { max_files: limit, depth } });
  }

  function safeSearch(query, kind, limit) { try { return search.search({ query, kind, limit }).matches ?? []; } catch { return []; } }
  function isIgnored(path) { return ignoredPaths.some((prefix) => path === prefix || path.startsWith(prefix)); }
  function normalizePrefixes(value) {
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.length === 0 || value.some((prefix) => typeof prefix !== "string" || !prefix.trim())) throw new ConfigurationError("Relevant Tree allowed_prefixes must be a non-empty string array.");
    return Object.freeze(value.map((prefix) => { const normalized = prefix.trim(); return normalized.endsWith("/") ? normalized : `${normalized}/`; }));
  }
}
