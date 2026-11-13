/**
 * Candidate accuracy evaluation computes reproducible retrieval metrics from
 * project-tracked golden queries. It reports ranking quality and safety
 * rejections separately so benchmark output cannot grant source access.
 */

/**
 * Computes Precision@K, Recall@K, symbol-hit rate, AC coverage and rejection
 * metrics from candidate outputs and independently verified golden labels.
 */
export function evaluateRetrievalCases(cases = [], { k = 5, corpusRevision = null, retrievalConfig = null, datasetChecksum = null, knowledgeRevision = null, modelIdentity = null, indexIdentity = null, verifierProvenance = [], regressionResults = [] } = {}) {
  const totals = { precision: 0, recall: 0, symbolHits: 0, acCoverage: 0, falsePositives: 0, staleRejected: 0, unauthorizedRejected: 0, liveCacheParity: 0 };
  let evaluated = 0;
  const perCase = cases.map((item) => {
    const expected = new Set((item.expected_files ?? item.ground_truth ?? []).map(String));
    const expectedSymbols = new Set((item.expected_symbols ?? []).map((entry) => `${entry.path}#${entry.symbol ?? ""}`));
    const candidates = (item.candidates ?? []).slice(0, k);
    const paths = new Set(candidates.map((candidate) => String(candidate.path ?? candidate)));
    const hits = [...expected].filter((path) => paths.has(path)).length;
    const symbolHit = expectedSymbols.size === 0 ? (hits > 0 ? 1 : 0) : [...expectedSymbols].some((value) => candidates.some((candidate) => value === `${candidate.path}#${candidate.symbol ?? ""}`)) ? 1 : 0;
    const falsePositive = candidates.filter((candidate) => !expected.has(String(candidate.path ?? candidate))).length;
    const acCovered = Array.isArray(item.acceptance_criteria) && item.acceptance_criteria.length
      ? item.acceptance_criteria.filter((criterion) => candidates.some((candidate) => (candidate.matched_ac ?? []).includes(criterion))).length / item.acceptance_criteria.length
      : 0;
    const staleRejected = Number(item.stale_rejected ?? 0);
    const unauthorizedRejected = Number(item.unauthorized_rejected ?? 0);
    const identity = (candidate) => JSON.stringify([candidate?.path ?? null, candidate?.symbol ?? null, candidate?.sha256 ?? candidate?.source_sha256 ?? null, candidate?.source_revision ?? null, candidate?.receipt?.status ?? null, candidate?.fresh ?? null, candidate?.scope ?? null]);
    const parity = item.live_candidates && item.cached_candidates
      ? JSON.stringify(item.live_candidates.map(identity).sort()) === JSON.stringify(item.cached_candidates.map(identity).sort()) ? 1 : 0
      : null;
    evaluated++;
    totals.precision += candidates.length ? hits / candidates.length : 0;
    totals.recall += expected.size ? hits / expected.size : 0;
    totals.symbolHits += symbolHit;
    totals.acCoverage += acCovered;
    totals.falsePositives += candidates.length ? falsePositive / candidates.length : 0;
    totals.staleRejected += staleRejected;
    totals.unauthorizedRejected += unauthorizedRejected;
    if (parity !== null) totals.liveCacheParity += parity;
    return { id: item.id, precision_at_k: candidates.length ? hits / candidates.length : 0, recall_at_k: expected.size ? hits / expected.size : 0, symbol_hit_rate: symbolHit, ac_coverage: acCovered, false_positive_rate: candidates.length ? falsePositive / candidates.length : 0, stale_rejected: staleRejected, unauthorized_rejected: unauthorizedRejected, live_cache_parity: parity };
  });
  const divisor = Math.max(1, evaluated);
  return { dataset_checksum: datasetChecksum, knowledge_revision: knowledgeRevision, model_identity: modelIdentity, index_identity: indexIdentity,
    verifier_provenance: verifierProvenance, regression_results: regressionResults,
    provenance_complete: Boolean(datasetChecksum && knowledgeRevision && modelIdentity && indexIdentity && verifierProvenance.length && regressionResults.length),
    fallback_counts: cases.reduce((counts, item) => { for (const reason of item.fallback_reasons ?? []) counts[reason] = (counts[reason] ?? 0) + 1; return counts; }, {}),
    corpus_revision: corpusRevision, retrieval_config: retrievalConfig, k, cases: perCase, metrics: { precision_at_k: totals.precision / divisor, recall_at_k: totals.recall / divisor, symbol_hit_rate: totals.symbolHits / divisor, ac_coverage: totals.acCoverage / divisor, false_positive_rate: totals.falsePositives / divisor, stale_candidate_rejection: totals.staleRejected / divisor, unauthorized_candidate_rejection: totals.unauthorizedRejected / divisor, live_cache_parity: totals.liveCacheParity / divisor } };
}
