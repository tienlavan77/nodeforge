// Selects a bounded set of indexed files relevant to a natural-language task.
import { ConfigurationError } from "../../shared/errors.js";
import { tokenizeSearchText } from "./search-vocabulary.js";
import { extractExplicitPaths } from "./ticket-scope.js";

// Creates the synchronous relevance selector and its graph-scoring helpers.
export function createRelevantTreeScoring({ search, fileGraph, logger, maxFiles, defaultDepth, ignoredPaths }) {
  const isIgnored = (path) => ignoredPaths.some((prefix) => path === prefix || path.startsWith(prefix));
  function select({ title = "", objective = "", acceptanceCriteria = [], acceptance_criteria = [], style, depth = defaultDepth, limit = maxFiles, scope = "all", allowed_prefixes, allowedPrefixes, priorFiles = [], prior_files = [], dependencyFiles = [], dependency_files = [] } = {}) {
    const criteria = acceptanceCriteria.length ? acceptanceCriteria : acceptance_criteria;
    const text = [title, objective, ...(Array.isArray(criteria) ? criteria : [])].filter((value) => typeof value === "string" && value.trim()).join(" ");
    if (!text) throw new ConfigurationError("Relevant Tree requires ticket title, objective, or acceptance criteria.");
    if (!Number.isInteger(depth) || depth < 0 || depth > 3) throw new ConfigurationError("Relevant Tree depth must be an integer between 0 and 3.");
    if (!Number.isInteger(limit) || limit < 1 || limit > maxFiles) throw new ConfigurationError(`Relevant Tree limit must be between 1 and ${maxFiles}.`);
    const normalizedScope = typeof scope === "string" && scope.trim() ? scope.trim() : "all";
    const stylePrefixes = styleToPrefixes(style);
    const normalizedAllowedPrefixes = normalizePrefixes(allowed_prefixes ?? allowedPrefixes ?? stylePrefixes);
    let effectiveLimit = limit;
    if (Array.isArray(style) && style.length > 1 && effectiveLimit <= 4) effectiveLimit = Math.min(8, maxFiles);
    const seeds = new Map();
    const shortlist = new Map();
    const shortlistAdd = (entry, why) => {
      const path = entry?.node?.path ?? entry?.path;
      if (!path || isIgnored(path) || path.includes(".test.") || (normalizedAllowedPrefixes && !normalizedAllowedPrefixes.some((prefix) => path.startsWith(prefix)))) return;
      const current = shortlist.get(path) ?? { path, terms: new Set(), kinds: new Set(), node: entry.node ?? entry };
      if (why?.term) current.terms.add(why.term);
      if (why?.kind) current.kinds.add(why.kind);
      if (why?.reason) (current.reasons ??= new Set()).add(why.reason);
      if (!current.node?.id && entry.node?.id) current.node = entry.node;
      shortlist.set(path, current);
    };
    const add = (entry, score, reason, relation = null) => {
      const path = entry?.node?.path ?? entry?.path;
      if (!path || isIgnored(path) || path.includes(".test.") || (normalizedAllowedPrefixes && !normalizedAllowedPrefixes.some((prefix) => path.startsWith(prefix)))) return;
      const current = seeds.get(path) ?? { path, score: 0, t1: 0, reasons: new Set(), relations: [], node: entry.node ?? entry };
      current.score = Math.min(18, current.score + score);
      current.reasons.add(reason);
      if (relation) current.relations.push(relation);
      if (!current.node?.id && entry.node?.id) current.node = entry.node;
      seeds.set(path, current);
    };
    const neighborsOf = (path) => {
      try { return [...fileGraph.getDependencies(path, 1).edges, ...fileGraph.getDependents(path, 1).edges]; }
      catch (error) { log("debug", "Relevant tree graph lookup fallback returned no neighbors.", error, { path }); return []; }
    };
    const terms = tokenizeSearchText(text, { minLength: 3 });
    const scopedPaths = resolveScopedPaths({ title, objective, criteria, priorFiles: priorFiles.length ? priorFiles : prior_files, dependencyFiles: dependencyFiles.length ? dependencyFiles : dependency_files, isIgnored });
    for (const scoped of scopedPaths) {
      add({ path: scoped.path, node: { path: scoped.path } }, scoped.score, scoped.reason, null);
      const seed = seeds.get(scoped.path);
      if (seed && !seed.t1) seed.t1 = scoped.score;
    }
    for (const term of terms) {
      for (const match of safeSearch(term, "file", Math.min(effectiveLimit, 20))) shortlistAdd(match, { term, kind: "file", reason: (match.reason ?? ["file"])[0] });
      for (const match of safeSearch(term, "symbol", Math.min(effectiveLimit, 20))) shortlistAdd(match, { term, kind: "symbol", reason: (match.reason ?? ["symbol"])[0] });
    }
    const termDocCount = new Map();
    for (const cand of shortlist.values()) for (const term of cand.terms) termDocCount.set(term, (termDocCount.get(term) ?? 0) + 1);
    const totalDocs = Math.max(1, shortlist.size);
    const termIdf = new Map([...termDocCount.entries()].map(([term, df]) => [term, Math.log(totalDocs / Math.max(1, df)) + 1]));
    for (const cand of shortlist.values()) {
      const idfs = [...cand.terms].map((term) => termIdf.get(term) ?? 1).sort((a, b) => b - a).slice(0, 3);
      if (!idfs.length) continue;
      const kindsBonus = cand.kinds.has("file") && cand.kinds.has("symbol") ? 1 : 0;
      const points = Math.round((idfs.reduce((a, b) => a + b, 0) + kindsBonus) * 2) / 2;
      add({ path: cand.path, node: cand.node }, points, `tier1:${[...cand.terms].slice(0, 3).join(",")}`, null);
      const seed = seeds.get(cand.path);
      if (seed) seed.t1 = points;
    }
    expandGraph(seeds, depth, add, neighborsOf);
    for (const query of buildContentQueries({ title, objective })) {
      for (const match of safeSearch(query, "content", Math.min(Math.max(effectiveLimit * 2, 8), 20))) {
        const path = match.node?.path ?? match.path;
        const current = path ? seeds.get(path) : null;
        if (current && current.score >= 4) continue;
        add(match, Math.min(2, Number(match.score) || 0.1), `tier3:${(match.reason ?? ["content"])[0]}`, null);
      }
    }
    const skipTermSearch = [...seeds.values()].some((seed) => seed.score >= 4);
    for (const term of terms) {
      if (skipTermSearch && terms.length > 6) continue;
      addTermMatchesDeduped(term, safeSearch(term, "all", Math.min(effectiveLimit, 20)), !skipTermSearch);
    }
    const matches = [...seeds.values()].sort((a, b) => b.score - a.score || b.t1 - a.t1 || (a.hop ?? 0) - (b.hop ?? 0) || (a.relations.length === 0 ? 0 : 1) - (b.relations.length === 0 ? 0 : 1) || a.path.localeCompare(b.path)).slice(0, effectiveLimit).map((item) => ({ path: item.path, score: Number(item.score.toFixed(4)), reason: [...item.reasons], relations: item.relations, node: item.node, confidence: "static" }));
    return Object.freeze({ query: text, scope: normalizedScope, allowed_prefixes: normalizedAllowedPrefixes ?? undefined, tree: Object.freeze(matches), index_version: matches[0]?.node?.index_version ?? undefined, limits: { max_files: effectiveLimit, depth } });

    function safeSearch(query, kind, searchLimit) { try { return search.search({ query, kind, limit: searchLimit }).matches ?? []; } catch (error) { log("debug", "Relevant tree search fallback returned no matches.", error, { query, kind }); return []; } }
    function addTermMatchesDeduped(term, matches, expand) {
      const best = new Map();
      for (const match of matches) {
        const path = match?.node?.path ?? match?.path;
        if (!path) continue;
        const score = Number(match.score) || 0.1;
        const reason = match.reason?.length ? match.reason.join(";") : `search:${term}`;
        const current = best.get(path);
        if (!current || score > current.score) best.set(path, { match, score, reason });
      }
      for (const { match, score, reason } of best.values()) {
        add(match, score, reason);
        const path = match.node?.path;
        if (!expand || !path || depth === 0) continue;
        for (const relation of neighborsOf(path)) {
          const linked = relation.from === path ? relation.to : relation.from;
          add({ path: linked, node: { path: linked } }, score * 0.5, `graph:${relation.kind}`, relation);
        }
      }
    }
    function log(level, message, error, context = {}) { try { logger?.[level]?.(message, { error: error?.message, ...context }); } catch (loggingError) { void loggingError; } }
  }
  return select;

  // Expands scoped and lexical seeds through bounded graph relations.
  function expandGraph(seeds, depth, add, neighborsOf) {
    const reached = new Map();
    const addLink = (linked, relation, points, reason, hop) => {
      if (!linked) return;
      const count = (reached.get(linked) ?? 0) + 1;
      if (count > 2) return;
      reached.set(linked, count);
      add({ path: linked, node: { path: linked } }, count === 1 ? points : points * 0.5, reason, relation);
      const current = seeds.get(linked);
      if (current && (current.hop === undefined || hop < current.hop)) current.hop = hop;
    };
    if (depth === 0) return;
    const anchors = [...seeds.values()].filter((seed) => seed.t1 > 0).sort((a, b) => b.t1 - a.t1).slice(0, 8);
    for (const seed of anchors) for (const relation of neighborsOf(seed.path)) {
      const linked = relation.from === seed.path ? relation.to : relation.from;
      if (linked && linked !== seed.path) addLink(linked, relation, relation.from === seed.path ? 2 : 1, "tier2:graph-hop1", 1);
    }
    const entries = [...seeds.values()].filter((seed) => [...seed.reasons].some((reason) => reason.startsWith("tier0:"))).slice(0, 4);
    if (depth >= 2) entries.push(...[...seeds.values()].filter((seed) => seed.t1 > 0 && !entries.some((item) => item.path === seed.path)).sort((a, b) => b.t1 - a.t1).slice(0, 4));
    for (const entry of entries) for (const relation of neighborsOf(entry.path).slice(0, 10)) {
      const hop1 = relation.from === entry.path ? relation.to : relation.from;
      if (!hop1 || hop1 === entry.path) continue;
      for (const rel2 of neighborsOf(hop1).slice(0, 10)) {
        const hop2 = rel2.from === hop1 ? rel2.to : rel2.from;
        if (!hop2 || hop2 === entry.path || hop2 === hop1 || seeds.has(hop2)) continue;
        addLink(hop2, rel2, rel2.from === hop1 ? 1 : 0.5, "tier2:graph-hop2", 2);
      }
    }
  }
}

function resolveScopedPaths({ title, objective, criteria, priorFiles = [], dependencyFiles = [], isIgnored }) {
  const out = [];
  const seen = new Set();
  const push = (path, score, reason) => { if (typeof path !== "string" || !path.includes("/") || seen.has(path) || isIgnored(path) || path.includes(".test.")) return; seen.add(path); out.push({ path, score, reason }); };
  for (const path of extractExplicitPaths({ title, objective, acceptance_criteria: Array.isArray(criteria) ? criteria : [] })) push(path, 6, "tier0:explicit");
  for (const path of asPathList(priorFiles)) push(path, 3, "tier0:prior");
  for (const path of asPathList(dependencyFiles)) push(path, 4, "tier0:dependency");
  return out;
}
function asPathList(value) { return Array.isArray(value) ? value.map((entry) => typeof entry === "string" ? entry : entry?.path).filter((path) => typeof path === "string" && path) : []; }
function buildContentQueries({ title, objective }) { const queries = []; if (typeof title === "string" && title.trim()) queries.push(title.trim()); if (typeof objective === "string" && objective.trim() && objective.trim() !== title?.trim()) queries.push(objective.trim().slice(0, 400)); return queries.slice(0, 2); }
function styleToPrefixes(style) { if (!style) return undefined; const prefixes = []; for (const value of Array.isArray(style) ? style : [style]) { if (value === "frontend") prefixes.push("ui/", "web/src/"); else if (value === "backend") prefixes.push("backend/", "schemas/"); else if (value === "security") prefixes.push("backend/src/modules/agent/", "backend/src/infrastructure/", "schemas/"); else if (value === "infra") prefixes.push("backend/src/infrastructure/", ".forge/"); else if (value === "docs") prefixes.push("docs/", "schemas/"); } return prefixes.length ? prefixes : undefined; }
function normalizePrefixes(value) { if (value === undefined) return null; if (!Array.isArray(value) || value.length === 0 || value.some((prefix) => typeof prefix !== "string" || !prefix.trim())) throw new ConfigurationError("Relevant Tree allowed_prefixes must be a non-empty string array."); return Object.freeze(value.map((prefix) => { const normalized = prefix.trim(); return normalized.endsWith("/") ? normalized : `${normalized}/`; })); }
