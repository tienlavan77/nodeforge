// Adds semantic and freshness signals to relevant-file selections.
import { ConfigurationError } from "../../shared/errors.js";
import { createRelevantTreeScoring } from "./relevant-tree-scoring.js";

// Creates retrieval variants that preserve bounded relevant-file selection.
export function createRelevantTreeSelector({ search, fileGraph, embeddingStore = null, embeddingProvider = null, freshnessChecker = null, logger = console, maxFiles = 30, defaultDepth = 1, ignoredPaths = [".git/", ".forge/runtime/", ".next/", ".next.stale-"] } = {}) {
  if (!search || typeof search.search !== "function") throw new ConfigurationError("Relevant Tree requires Code Search.");
  if (!fileGraph || typeof fileGraph.getDependencies !== "function" || typeof fileGraph.getDependents !== "function") throw new ConfigurationError("Relevant Tree requires File Graph.");
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new ConfigurationError("Relevant Tree maxFiles must be a positive integer.");
  const select = createRelevantTreeScoring({ search, fileGraph, logger, maxFiles, defaultDepth, ignoredPaths });
  return Object.freeze({ select, selectFresh, selectWithEmbeddings, selectFreshWithEmbeddings });

  // Verifies shortlist freshness while keeping stale paths visible for review.
  async function selectFresh(args = {}) {
    const base = select(args);
    if (!freshnessChecker || typeof freshnessChecker.checkPaths !== "function") return base;
    try {
      const paths = base.tree.map((entry) => entry.path);
      const verdicts = await freshnessChecker.checkPaths(paths);
      return applyFreshness(base, paths, verdicts);
    } catch (error) { log("warn", "Relevant tree freshness check failed; returning base selection.", error); return base; }
  }

  // Merges one ticket embedding with lexical and graph retrieval scores.
  async function selectWithEmbeddings(args = {}) {
    const requestedLimit = Number.isInteger(args.limit) ? args.limit : maxFiles;
    const base = select({ ...args, limit: maxFiles });
    const limitedBase = () => Object.freeze({ ...base, tree: Object.freeze(base.tree.slice(0, requestedLimit)), limits: { ...base.limits, max_files: requestedLimit } });
    if (!embeddingStore || !embeddingProvider) return limitedBase();
    try {
      const queryText = [args.title, args.objective].filter((value) => typeof value === "string" && value.trim()).join("\n").slice(0, 2000);
      if (!queryText.trim()) return limitedBase();
      const prefixes = base.allowed_prefixes ? [...base.allowed_prefixes] : undefined;
      const queryVector = await embeddingProvider.embed(queryText);
      const hits = embeddingStore.search(queryVector, { limit: maxFiles * 2, allowedPrefixes: prefixes });
      if (!hits.length) return limitedBase();
      const lexicalWeight = readWeight(process.env.RETRIEVAL_LEXICAL_WEIGHT, 0.65);
      const semanticWeight = readWeight(process.env.RETRIEVAL_SEMANTIC_WEIGHT, 0.35);
      const lexicalValues = base.tree.map((entry) => Number(entry.score) || 0);
      const lexicalMin = Math.min(...lexicalValues, 0);
      const lexicalMax = Math.max(...lexicalValues, 1);
      const semanticValues = hits.map((entry) => Number(entry.score) || 0);
      const semanticMin = Math.min(...semanticValues, 0);
      const semanticMax = Math.max(...semanticValues, 1);
      const normalize = (value, min, max) => max > min ? (value - min) / (max - min) : 0;
      const merged = new Map(base.tree.map((entry) => [entry.path, { ...entry, score: normalize(Number(entry.score) || 0, lexicalMin, lexicalMax), reasons: [...(entry.reasons ?? entry.reason ?? [])] }]));
      for (const hit of hits) {
        const current = merged.get(hit.path);
        const semanticScore = normalize(Number(hit.score) || 0, semanticMin, semanticMax);
        if (current) { current.score = current.score * lexicalWeight + semanticScore * semanticWeight; current.reasons.push("tier-semantic:embedding"); current.reason = current.reasons; }
        else merged.set(hit.path, { path: hit.path, score: semanticScore * semanticWeight, reason: ["tier-semantic:embedding"], reasons: ["tier-semantic:embedding"], relations: [], node: { path: hit.path }, confidence: "static" });
      }
      const sorted = [...merged.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      const tree = sorted.slice(0, requestedLimit);
      const retrievalDiagnostics = process.env.RETRIEVAL_DEBUG_POOL === "1" ? sorted.map((entry) => {
        const lexical = base.tree.find((item) => item.path === entry.path)?.score ?? 0;
        const semantic = hits.find((item) => item.path === entry.path)?.score ?? 0;
        return { path: entry.path, lexical_score: Number(normalize(Number(lexical), lexicalMin, lexicalMax).toFixed(6)), semantic_score: Number(normalize(Number(semantic), semanticMin, semanticMax).toFixed(6)), final_score: Number(entry.score.toFixed(6)) };
      }) : undefined;
      return Object.freeze({ ...base, tree: Object.freeze(tree), ...(retrievalDiagnostics ? { retrieval_diagnostics: Object.freeze(retrievalDiagnostics) } : {}), limits: { ...base.limits, max_files: requestedLimit } });
    } catch (error) { log("warn", "Relevant tree embedding merge failed; returning lexical selection.", error); return limitedBase(); }
  }

  // Applies live-content freshness validation after semantic ranking.
  async function selectFreshWithEmbeddings(args = {}) {
    const base = await selectWithEmbeddings(args);
    if (!freshnessChecker || typeof freshnessChecker.checkPaths !== "function") return base;
    try { const paths = base.tree.map((entry) => entry.path); return applyFreshness(base, paths, await freshnessChecker.checkPaths(paths)); }
    catch (error) { log("warn", "Relevant tree semantic freshness check failed; returning base selection.", error); return base; }
  }

  function applyFreshness(base, paths, verdicts) {
    const byPath = new Map(verdicts.map((verdict) => [verdict.path, verdict.status]));
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
    const counts = { checked: paths.length, fresh: fresh.length, stale: stale.filter((entry) => entry.reason.some((reason) => reason.includes("index-stale"))).length, missing: verdicts.filter((verdict) => verdict.status === "missing").length, unreadable: verdicts.filter((verdict) => verdict.status === "unreadable").length };
    return Object.freeze({ ...base, tree, freshness: Object.freeze(counts), stale_paths: Object.freeze(stale.map((entry) => entry.path)) });
  }
  function log(level, message, error) { try { logger?.[level]?.(message, { error: error?.message }); } catch (loggingError) { void loggingError; } }
}

function readWeight(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback; }
