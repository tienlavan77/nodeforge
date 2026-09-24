// relevant tree - provides relevant tree functionality for NodeForge.
import { ConfigurationError } from "../../shared/errors.js";
import { tokenizeSearchText } from "./search-vocabulary.js";
import { extractExplicitPaths } from "./ticket-scope.js";

/** Select a bounded set of indexed files relevant to a natural-language task. */
export function createRelevantTreeSelector({ search, fileGraph, embeddingStore = null, embeddingProvider = null, freshnessChecker = null, logger = console, maxFiles = 30, defaultDepth = 1, ignoredPaths = [".git/", ".forge/runtime/", ".next/", ".next.stale-"] } = {}) {
  if (!search || typeof search.search !== "function") throw new ConfigurationError("Relevant Tree requires Code Search.");
  if (!fileGraph || typeof fileGraph.getDependencies !== "function" || typeof fileGraph.getDependents !== "function") throw new ConfigurationError("Relevant Tree requires File Graph.");
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new ConfigurationError("Relevant Tree maxFiles must be a positive integer.");
  const lexicalWeight = readWeight(process.env.RETRIEVAL_LEXICAL_WEIGHT, 0.65);
  const semanticWeight = readWeight(process.env.RETRIEVAL_SEMANTIC_WEIGHT, 0.35);
  return Object.freeze({ select, selectFresh, selectWithEmbeddings, selectFreshWithEmbeddings });

  // Freshness-aware variant: runs the sync select, then verifies the shortlist
  // against live disk content. Stale entries are demoted to the end and flagged
  // `stale: true` ("needs verify") instead of being silently returned or dropped.
  async function selectFresh(args = {}) {
    const base = select(args);
    if (!freshnessChecker || typeof freshnessChecker.checkPaths !== "function") return base;
    try {
      const paths = base.tree.map((entry) => entry.path);
      const verdicts = await freshnessChecker.checkPaths(paths);
      const byPath = new Map(verdicts.map((v) => [v.path, v.status]));
      const fresh = [];
      const stale = [];
      for (const entry of base.tree) {
        const status = byPath.get(entry.path) ?? "unreadable";
        if (status === "fresh") { fresh.push(entry); continue; }
        const prior = Array.isArray(entry.reason) ? entry.reason : [...(entry.reasons ?? [])];
        stale.push({ ...entry, stale: true, reason: [...prior, `stale:index-${status}-needs-verify`], reasons: [...prior, `stale:index-${status}-needs-verify`] });
      }
      const tree = Object.freeze([...fresh, ...stale]);
      const counts = { checked: paths.length, fresh: fresh.length, stale: stale.filter((e) => e.reason.some((r) => r.includes("index-stale"))).length, missing: verdicts.filter((v) => v.status === "missing").length, unreadable: verdicts.filter((v) => v.status === "unreadable").length };
      return Object.freeze({ ...base, tree, freshness: Object.freeze(counts), stale_paths: Object.freeze(stale.map((e) => e.path)) });
    } catch (error) {
      log("warn", "Relevant tree freshness check failed; returning base selection.", error);
      return base;
    }
  }

  // Async variant that adds the semantic leg: embed ticket once at Node layer,
  // cosine-search stored file vectors, merge with lexical+graph scores.
  async function selectWithEmbeddings(args = {}) {
    const requestedLimit = Number.isInteger(args.limit) ? args.limit : maxFiles;
    // Keep a wider lexical pool so semantic candidates can compete before the final cut.
    const base = select({ ...args, limit: maxFiles });
    const limitedBase = () => Object.freeze({ ...base, tree: Object.freeze(base.tree.slice(0, requestedLimit)), limits: { ...base.limits, max_files: requestedLimit } });
    if (!embeddingStore || !embeddingProvider) return limitedBase();
    try {
      const queryText = [args.title, args.objective].filter((v) => typeof v === "string" && v.trim()).join("\n").slice(0, 2000);
      if (!queryText.trim()) return limitedBase();
      const prefixes = base.allowed_prefixes ? [...base.allowed_prefixes] : undefined;
      const queryVector = await embeddingProvider.embed(queryText);
      const hits = embeddingStore.search(queryVector, { limit: maxFiles * 2, allowedPrefixes: prefixes });
      if (!hits.length) return limitedBase();
      const lexicalValues = base.tree.map((entry) => Number(entry.score) || 0);
      const lexicalMin = Math.min(...lexicalValues, 0);
      const lexicalMax = Math.max(...lexicalValues, 1);
      const semanticValues = hits.map((entry) => Number(entry.score) || 0);
      const semanticMin = Math.min(...semanticValues, 0);
      const semanticMax = Math.max(...semanticValues, 1);
      const normalize = (value, min, max) => max > min ? (value - min) / (max - min) : 0;
      const merged = new Map(base.tree.map((entry) => [entry.path, {
        ...entry,
        score: normalize(Number(entry.score) || 0, lexicalMin, lexicalMax),
        reasons: [...(entry.reasons ?? entry.reason ?? [])]
      }]));
      for (const hit of hits) {
        const current = merged.get(hit.path);
        const semanticScore = normalize(Number(hit.score) || 0, semanticMin, semanticMax);
        if (current) {
          current.score = current.score * lexicalWeight + semanticScore * semanticWeight;
          current.reasons.push("tier-semantic:embedding");
          current.reason = current.reasons;
        } else {
          merged.set(hit.path, { path: hit.path, score: semanticScore * semanticWeight, reason: ["tier-semantic:embedding"], reasons: ["tier-semantic:embedding"], relations: [], node: { path: hit.path }, confidence: "static" });
        }
      }
      const tree = [...merged.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, requestedLimit);
      const diagnostics = process.env.RETRIEVAL_DEBUG_POOL === "1"
        ? [...merged.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).map((entry) => {
          const lexical = base.tree.find((item) => item.path === entry.path)?.score ?? 0;
          const semantic = hits.find((item) => item.path === entry.path)?.score ?? 0;
          return { path: entry.path, lexical_score: Number(normalize(Number(lexical), lexicalMin, lexicalMax).toFixed(6)), semantic_score: Number(normalize(Number(semantic), semanticMin, semanticMax).toFixed(6)), final_score: Number(entry.score.toFixed(6)) };
        })
        : undefined;
      return Object.freeze({ ...base, tree: Object.freeze(tree), ...(diagnostics ? { retrieval_diagnostics: Object.freeze(diagnostics) } : {}), limits: { ...base.limits, max_files: requestedLimit } });
    } catch (error) {
      log("warn", "Relevant tree embedding merge failed; returning lexical selection.", error);
      return limitedBase();
    }
  }

  // Semantic variant with the same live-content freshness validation as selectFresh.
  async function selectFreshWithEmbeddings(args = {}) {
    const base = await selectWithEmbeddings(args);
    if (!freshnessChecker || typeof freshnessChecker.checkPaths !== "function") return base;
    try {
      const paths = base.tree.map((entry) => entry.path);
      const verdicts = await freshnessChecker.checkPaths(paths);
      const byPath = new Map(verdicts.map((v) => [v.path, v.status]));
      const fresh = [];
      const stale = [];
      for (const entry of base.tree) {
        const status = byPath.get(entry.path) ?? "unreadable";
        if (status === "fresh") { fresh.push(entry); continue; }
        const prior = Array.isArray(entry.reason) ? entry.reason : [...(entry.reasons ?? [])];
        const reason = [...prior, `stale:index-${status}-needs-verify`];
        stale.push({ ...entry, stale: true, reason, reasons: reason });
      }
      const tree = Object.freeze([...fresh, ...stale]);
      const counts = { checked: paths.length, fresh: fresh.length, stale: stale.filter((e) => e.reason.some((r) => r.includes("index-stale"))).length, missing: verdicts.filter((v) => v.status === "missing").length, unreadable: verdicts.filter((v) => v.status === "unreadable").length };
      return Object.freeze({ ...base, tree, freshness: Object.freeze(counts), stale_paths: Object.freeze(stale.map((e) => e.path)) });
    } catch (error) {
      log("warn", "Relevant tree semantic freshness check failed; returning base selection.", error);
      return base;
    }
  }

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
    const isMixedStyle = Array.isArray(style) && style.length > 1;
    if (isMixedStyle && effectiveLimit <= 4) effectiveLimit = Math.min(8, maxFiles);
    const seeds = new Map();
    // Phase 1 — shortlist (no scoring): collect candidate paths from name search.
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
    const terms = tokenizeSearchText(text, { minLength: 3 });
    // Tier 0 — ticket scope: explicit paths named in AC/objective plus files
    // touched by dependency tickets. Seeded before full-graph search so
    // context narrows the candidate set instead of searching the whole repo.
    const scopedPaths = resolveScopedPaths({ title, objective, criteria, priorFiles: priorFiles.length ? priorFiles : prior_files, dependencyFiles: dependencyFiles.length ? dependencyFiles : dependency_files });
    for (const scoped of scopedPaths) {
      add({ path: scoped.path, node: { path: scoped.path } }, scoped.score, scoped.reason, null);
      const seed = seeds.get(scoped.path);
      if (seed && !seed.t1) seed.t1 = scoped.score;
    }
    // Phase 1: name shortlist — file path segments + symbol names, no points yet.
    for (const term of terms) {
      for (const match of safeSearch(term, "file", Math.min(effectiveLimit, 20))) {
        shortlistAdd(match, { term, kind: "file", reason: (match.reason ?? ["file"])[0] });
      }
      for (const match of safeSearch(term, "symbol", Math.min(effectiveLimit, 20))) {
        shortlistAdd(match, { term, kind: "symbol", reason: (match.reason ?? ["symbol"])[0] });
      }
    }
    // Phase 2 — scoring: distinctive terms (few files) weigh more than generic ones.
    // idf(term) = log(totalShortlisted / filesWithTerm); rare match wins.
    const termDocCount = new Map();
    for (const cand of shortlist.values()) {
      for (const term of cand.terms) termDocCount.set(term, (termDocCount.get(term) ?? 0) + 1);
    }
    const totalDocs = Math.max(1, shortlist.size);
    const termIdf = new Map([...termDocCount.entries()].map(([term, df]) => [term, Math.log(totalDocs / Math.max(1, df)) + 1]));
    for (const cand of shortlist.values()) {
      const idfs = [...cand.terms].map((t) => termIdf.get(t) ?? 1).sort((a, b) => b - a).slice(0, 3);
      if (!idfs.length) continue;
      const kindsBonus = cand.kinds.has("file") && cand.kinds.has("symbol") ? 1 : 0;
      const pts = Math.round((idfs.reduce((a, b) => a + b, 0) + kindsBonus) * 2) / 2;
      add({ path: cand.path, node: cand.node }, pts, `tier1:${[...cand.terms].slice(0, 3).join(",")}`, null);
      const seed = seeds.get(cand.path);
      if (seed) seed.t1 = pts;
    }
    // Tier 2 — hop-decayed graph expansion. 1-hop neighbors of the top-8
    // tier-1 anchors score full points (dependency 2, dependent 1). At depth
    // >= 2 a second ring expands from tier-0 entry points at half points, so
    // directly-linked files outrank indirect ones. A file reached from several
    // anchors is usually a shared hub (errors.js, agent-contract.js): repeat
    // anchors contribute half points instead of stacking linearly.
    const graphReached = new Map();
    const addGraphLink = (linked, relation, basePts, reason, hop) => {
      if (!linked) return;
      const count = (graphReached.get(linked) ?? 0) + 1;
      // Cap at two contributing anchors: the third anchor onward adds noise,
      // not signal — that is exactly how hubs (errors.js) used to climb.
      if (count > 2) return;
      graphReached.set(linked, count);
      add({ path: linked, node: { path: linked } }, count === 1 ? basePts : basePts * 0.5, reason, relation);
      const seed = seeds.get(linked);
      if (seed && (seed.hop === undefined || hop < seed.hop)) seed.hop = hop;
    };
    if (depth !== 0) {
      const topTier1 = [...seeds.values()].filter((s) => s.t1 > 0).sort((a, b) => b.t1 - a.t1).slice(0, 8);
      for (const seed of topTier1) {
        for (const relation of neighborsOf(seed.path)) {
          const linked = relation.from === seed.path ? relation.to : relation.from;
          if (!linked || linked === seed.path) continue;
          addGraphLink(linked, relation, relation.from === seed.path ? 2 : 1, "tier2:graph-hop1", 1);
        }
      }
      if (depth >= 1) {
        const tier0Paths = new Set();
        const entries = [...seeds.values()].filter((s) => [...s.reasons].some((r) => r.startsWith("tier0:"))).slice(0, 4);
        for (const entry of entries) tier0Paths.add(entry.path);
        // Depth 2+ also fans out from strong lexical seeds, not just entry points.
        if (depth >= 2) {
          for (const seed of [...seeds.values()].filter((s) => s.t1 > 0 && !tier0Paths.has(s.path)).sort((a, b) => b.t1 - a.t1).slice(0, 4)) entries.push(seed);
        }
        for (const entry of entries) {
          for (const relation of neighborsOf(entry.path).slice(0, 10)) {
            const hop1 = relation.from === entry.path ? relation.to : relation.from;
            if (!hop1 || hop1 === entry.path) continue;
            for (const rel2 of neighborsOf(hop1).slice(0, 10)) {
              const hop2 = rel2.from === hop1 ? rel2.to : rel2.from;
              if (!hop2 || hop2 === entry.path || hop2 === hop1 || seeds.has(hop2)) continue;
              addGraphLink(hop2, rel2, rel2.from === hop1 ? 1 : 0.5, "tier2:graph-hop2", 2);
            }
          }
        }
      }
    }
    // Tier 3 — FTS content recall, only fills files still below 4 points.
    for (const q of buildContentQueries({ title, objective })) {
      for (const match of safeSearch(q, "content", Math.min(Math.max(effectiveLimit * 2, 8), 20))) {
        const path = match.node?.path ?? match.path;
        const current = path ? seeds.get(path) : null;
        if (current && current.score >= 4) continue;
        add(match, Math.min(2, Number(match.score) || 0.1), `tier3:${(match.reason ?? ["content"])[0]}`, null);
      }
    }
    const skipTermSearch = [...seeds.values()].some((s) => s.score >= 4);
    // Dedupe term matches per file: one generic token matching many symbols
    // in the same file contributes its strongest single match only, so
    // breadth across distinct tokens still scores while repetition no longer
    // inflates.
    const addTermMatchesDeduped = (term, matches, expandGraph) => {
      const best = new Map();
      for (const match of matches) {
        const path = match?.node?.path ?? match?.path;
        if (!path) continue;
        const score = Number(match.score) || 0.1;
        const reason = [...(match.reason?.length ? [match.reason.join(";")] : [`search:${term}`])];
        const current = best.get(path);
        if (!current || score > current.score) best.set(path, { match, score, reason });
      }
      for (const { match, score, reason } of best.values()) {
        add(match, score, ...reason);
        const path = match.node?.path;
        if (!expandGraph || !path || depth === 0) continue;
        for (const relation of neighborsOf(path)) {
          const linked = relation.from === path ? relation.to : relation.from;
          add({ path: linked, node: { path: linked } }, score * 0.5, `graph:${relation.kind}`, relation);
        }
      }
    };
    if (!skipTermSearch) {
      for (const term of terms) {
        addTermMatchesDeduped(term, safeSearch(term, "all", Math.min(effectiveLimit, 20)), true);
      }
    } else {
      for (const term of terms) {
        // Keep stub-compatible term queries for tests that mock search but don't handle kind:content;
        // filter by count so real runs (content already ranked) keep only a few validating probes.
        if (terms.length > 6) continue;
        addTermMatchesDeduped(term, safeSearch(term, "all", Math.min(effectiveLimit, 20)), false);
      }
    }
    // Semantic leg removed from sync select — use selectWithEmbeddings for the
    // embedding leg (single per-select cost at Node layer, never in agent loops).
    const matches = [...seeds.values()].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.t1 !== a.t1) return b.t1 - a.t1;
      const aHop = a.hop ?? 0;
      const bHop = b.hop ?? 0;
      if (aHop !== bHop) return aHop - bHop;
      const aDirect = a.relations.length === 0 ? 0 : 1;
      const bDirect = b.relations.length === 0 ? 0 : 1;
      if (aDirect !== bDirect) return aDirect - bDirect;
      return a.path.localeCompare(b.path);
    }).slice(0, effectiveLimit).map((item) => ({ path: item.path, score: Number(item.score.toFixed(4)), reason: [...item.reasons], relations: item.relations, node: item.node, confidence: "static" }));
    return Object.freeze({ query: text, scope: normalizedScope, allowed_prefixes: normalizedAllowedPrefixes ?? undefined, tree: Object.freeze(matches), index_version: matches[0]?.node?.index_version ?? undefined, limits: { max_files: effectiveLimit, depth } });
  }

  function safeSearch(query, kind, limit) { try { return search.search({ query, kind, limit }).matches ?? []; } catch (error) { log("debug", "Relevant tree search fallback returned no matches.", error, { query, kind }); return []; } }
  // Single-hop neighbors only: callers walk outward ring by ring and tag the
  // hop explicitly, since the graph API merges multi-hop edges without labels.
  function neighborsOf(path) {
    try { return [...fileGraph.getDependencies(path, 1).edges, ...fileGraph.getDependents(path, 1).edges]; } catch (error) { log("debug", "Relevant tree graph lookup fallback returned no neighbors.", error, { path }); return []; }
  }
  // Tier-0 scope seeds: paths named in the ticket outrank lexical matches;
  // dependency-touched files come next. Both skip full-repo search noise.
  function resolveScopedPaths({ title, objective, criteria, priorFiles = [], dependencyFiles = [] }) {
    const out = [];
    const seen = new Set();
    const push = (path, score, reason) => {
      if (typeof path !== "string" || !path.includes("/") || seen.has(path)) return;
      if (isIgnored(path) || path.includes(".test.")) return;
      seen.add(path);
      out.push({ path, score, reason });
    };
    for (const path of extractExplicitPaths({ title, objective, acceptance_criteria: Array.isArray(criteria) ? criteria : [] })) push(path, 6, "tier0:explicit");
    for (const path of asPathList(priorFiles)) push(path, 3, "tier0:prior");
    for (const path of asPathList(dependencyFiles)) push(path, 4, "tier0:dependency");
    return out;
  }
  function asPathList(value) {
    // Normalizes a prior/dependency file list that may hold strings or {path} entries.
    if (!Array.isArray(value)) return [];
    return value.map((entry) => typeof entry === "string" ? entry : entry?.path).filter((p) => typeof p === "string" && p);
  }
  function buildContentQueries({ title, objective }) {
    const queries = [];
    if (typeof title === "string" && title.trim()) queries.push(title.trim());
    if (typeof objective === "string" && objective.trim() && objective.trim() !== title?.trim()) queries.push(objective.trim().slice(0, 400));
    return queries.slice(0, 2);
  }
  function styleToPrefixes(style) {
    if (!style) return undefined;
    const styles = Array.isArray(style) ? style : [style];
    const prefixes = [];
    for (const s of styles) {
      if (s === "frontend") prefixes.push("ui/", "web/src/");
      else if (s === "backend") prefixes.push("backend/", "schemas/");
      else if (s === "security") prefixes.push("backend/src/modules/agent/", "backend/src/infrastructure/", "schemas/");
      else if (s === "infra") prefixes.push("backend/src/infrastructure/", ".forge/");
      else if (s === "docs") prefixes.push("docs/", "schemas/");
    }
    return prefixes.length ? prefixes : undefined;
  }
  function isIgnored(path) { return ignoredPaths.some((prefix) => path === prefix || path.startsWith(prefix)); }
  function normalizePrefixes(value) {
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.length === 0 || value.some((prefix) => typeof prefix !== "string" || !prefix.trim())) throw new ConfigurationError("Relevant Tree allowed_prefixes must be a non-empty string array.");
    return Object.freeze(value.map((prefix) => { const normalized = prefix.trim(); return normalized.endsWith("/") ? normalized : `${normalized}/`; }));
  }
  // eslint-disable-next-line no-silent-catch -- Logging must not change retrieval behavior; fallback already returned.
  function log(level, message, error, context = {}) { try { logger?.[level]?.(message, { error: error?.message, ...context }); } catch { /* logging must not change retrieval behavior */ } }
}

// Parse an optional retrieval weight while preserving the production default.
function readWeight(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}
