/**
 * Candidate accuracy evaluation computes reproducible retrieval metrics from
 * project-tracked golden queries. It reports ranking quality and safety
 * rejections separately so benchmark output cannot grant source access.
 */

/**
 * Computes Precision@K, Recall@K, symbol-hit rate, AC coverage and rejection
 * metrics from candidate outputs and independently verified golden labels.
 */
export function evaluateRetrievalCases(cases = [], {
  k = 5,
  corpusRevision = null,
  retrievalConfig = null,
  datasetChecksum = null,
  knowledgeRevision = null,
  knowledgeArtifactRevision = null,
  reviewCommitSha = null,
  sourceSha256 = null,
  modelIdentity = null,
  indexIdentity = null,
  verifierProvenance = [],
  regressionResults = [],
  rejectionProbes = {}
} = {}) {
  const totals = {
    precision: 0, recall: 0, symbolHits: 0, acCoverage: 0, falsePositives: 0,
    precisionNumerator: 0, precisionDenominator: 0,
    recallNumerator: 0, recallDenominator: 0,
    symbolHitNumerator: 0, symbolHitDenominator: 0,
    acNumerator: 0, acDenominator: 0,
    falsePositiveNumerator: 0, falsePositiveDenominator: 0,
    parityNumerator: 0, parityDenominator: 0,
    staleRejected: 0, staleEligible: 0, unauthorizedRejected: 0,
    unauthorizedEligible: 0, liveCacheParity: 0
  };
  let evaluated = 0;
  const perCase = cases.map((item) => {
    const expected = new Set((item.expected_files ?? item.ground_truth ?? []).map(String));
    const expectedSymbols = new Set((item.expected_symbols ?? []).map((entry) => `${entry.path}#${entry.symbol ?? ""}`));
    const candidates = (item.candidates ?? []).slice(0, k);
    const paths = new Set(candidates.map((candidate) => String(candidate.path ?? candidate)));
    const hits = [...expected].filter((path) => paths.has(path)).length;
    const symbolHit = expectedSymbols.size === 0
      ? (hits > 0 ? 1 : 0)
      : [...expectedSymbols].some((value) => candidates.some((candidate) => value === `${candidate.path}#${candidate.symbol ?? ""}`)) ? 1 : 0;
    const falsePositive = candidates.filter((candidate) => !expected.has(String(candidate.path ?? candidate))).length;
    const acNumerator = Array.isArray(item.acceptance_criteria)
      ? item.acceptance_criteria.filter((criterion) => candidates.some((candidate) => (candidate.matched_ac ?? []).includes(criterion))).length
      : 0;
    const acDenominator = Array.isArray(item.acceptance_criteria) ? item.acceptance_criteria.length : 0;
    const acCovered = acDenominator ? acNumerator / acDenominator : 0;
    const staleRejected = Number(item.stale_rejected ?? 0);
    const staleEligible = Number(item.stale_rejection_eligible ?? 0);
    const unauthorizedRejected = Number(item.unauthorized_rejected ?? 0);
    const unauthorizedEligible = Number(item.unauthorized_rejection_eligible ?? 0);
    const identity = (candidate) => JSON.stringify([
      candidate?.path ?? null, candidate?.symbol ?? null,
      candidate?.sha256 ?? candidate?.source_sha256 ?? null,
      candidate?.source_revision ?? null, candidate?.receipt?.status ?? null,
      candidate?.fresh ?? null, candidate?.scope ?? null
    ]);
    const parity = item.live_candidates && item.cached_candidates
      ? JSON.stringify(item.live_candidates.map(identity).sort()) === JSON.stringify(item.cached_candidates.map(identity).sort()) ? 1 : 0
      : null;
    evaluated++;
    totals.precision += candidates.length ? hits / candidates.length : 0;
    totals.recall += expected.size ? hits / expected.size : 0;
    totals.symbolHits += symbolHit;
    totals.acCoverage += acCovered;
    totals.falsePositives += candidates.length ? falsePositive / candidates.length : 0;
    totals.precisionNumerator += hits;
    totals.precisionDenominator += candidates.length;
    totals.recallNumerator += hits;
    totals.recallDenominator += expected.size;
    totals.symbolHitNumerator += symbolHit;
    totals.symbolHitDenominator++;
    totals.acNumerator += acNumerator;
    totals.acDenominator += acDenominator;
    totals.falsePositiveNumerator += falsePositive;
    totals.falsePositiveDenominator += candidates.length;
    totals.staleRejected += staleRejected;
    totals.staleEligible += staleEligible;
    totals.unauthorizedRejected += unauthorizedRejected;
    totals.unauthorizedEligible += unauthorizedEligible;
    if (parity !== null) {
      totals.liveCacheParity += parity;
      totals.parityNumerator += parity;
      totals.parityDenominator++;
    }
    return {
      id: item.id,
      baseline_candidates: item.baseline_candidates ?? item.cached_candidates ?? [],
      reranked_candidates: item.reranked_candidates ?? item.live_candidates ?? candidates,
      rejected_case_count: Number(item.rejected_case_count ?? 0),
      precision_at_k: candidates.length ? hits / candidates.length : 0,
      recall_at_k: expected.size ? hits / expected.size : 0,
      symbol_hit_rate: symbolHit,
      ac_coverage: acCovered,
      false_positive_rate: candidates.length ? falsePositive / candidates.length : 0,
      stale_rejected: staleRejected,
      stale_rejection_eligible: staleEligible,
      unauthorized_rejected: unauthorizedRejected,
      unauthorized_rejection_eligible: unauthorizedEligible,
      stale_probe_diagnostics: item.stale_probe_diagnostics ?? null,
      unauthorized_probe_diagnostics: item.unauthorized_probe_diagnostics ?? null,
      live_cache_parity: parity
    };
  });
  const divisor = Math.max(1, evaluated);
  const staleRate = totals.staleEligible ? totals.staleRejected / totals.staleEligible : null;
  const unauthorizedRate = totals.unauthorizedEligible ? totals.unauthorizedRejected / totals.unauthorizedEligible : null;
  const staleDiagnostics = Array.isArray(rejectionProbes.stale) ? rejectionProbes.stale : [];
  const unauthorizedDiagnostics = Array.isArray(rejectionProbes.unauthorized) ? rejectionProbes.unauthorized : [];
  const rejectedCaseCount = perCase.reduce((count, item) => count + Number(item.rejected_case_count ?? 0), 0);
  // Business purpose: makes every aggregate metric auditable when the evaluation has no eligible cases or rejected observations.
  // Technical description: records numerator, denominator, case count and an explicit measured/not_measured status beside the legacy numeric metric.
  const metricDetail = (numerator, denominator) => ({
    numerator,
    denominator,
    case_count: evaluated,
    rejected_case_count: rejectedCaseCount,
    status: denominator > 0 ? "measured" : "not_measured",
    diagnostics: denominator > 0 ? [] : ["no eligible observations"]
  });
  const explicitRevisionFields = [corpusRevision, knowledgeArtifactRevision, reviewCommitSha, sourceSha256];
  const legacyProvenance = Boolean(datasetChecksum && knowledgeRevision && modelIdentity && indexIdentity && verifierProvenance.length && regressionResults.length);
  const provenanceComplete = legacyProvenance && explicitRevisionFields.every(Boolean);
  const metricDetails = {
    precision_at_k: metricDetail(totals.precisionNumerator, totals.precisionDenominator),
    recall_at_k: metricDetail(totals.recallNumerator, totals.recallDenominator),
    symbol_hit_rate: metricDetail(totals.symbolHitNumerator, totals.symbolHitDenominator),
    ac_coverage: metricDetail(totals.acNumerator, totals.acDenominator),
    false_positive_rate: metricDetail(totals.falsePositiveNumerator, totals.falsePositiveDenominator),
    stale_rejection: metricDetail(totals.staleRejected, totals.staleEligible),
    unauthorized_rejection: metricDetail(totals.unauthorizedRejected, totals.unauthorizedEligible),
    live_cache_parity: metricDetail(totals.parityNumerator, totals.parityDenominator)
  };
  return {
    dataset_checksum: datasetChecksum,
    knowledge_revision: knowledgeRevision,
    corpus_revision: corpusRevision,
    knowledge_artifact_revision: knowledgeArtifactRevision,
    review_commit_sha: reviewCommitSha,
    source_sha256: sourceSha256,
    model_identity: modelIdentity,
    index_identity: indexIdentity,
    verifier_provenance: verifierProvenance,
    regression_results: regressionResults,
    provenance_complete: provenanceComplete,
    fallback_counts: cases.reduce((counts, item) => {
      for (const reason of item.fallback_reasons ?? []) counts[reason] = (counts[reason] ?? 0) + 1;
      return counts;
    }, {}),
    retrieval_config: retrievalConfig,
    k,
    cases: perCase,
    rejection_evidence: {
      stale: { rejected: totals.staleRejected, eligible: totals.staleEligible, rate: staleRate, diagnostics: staleDiagnostics },
      unauthorized: { rejected: totals.unauthorizedRejected, eligible: totals.unauthorizedEligible, rate: unauthorizedRate, diagnostics: unauthorizedDiagnostics }
    },
    metric_details: metricDetails,
    metrics: {
      precision_at_k: totals.precision / divisor,
      recall_at_k: totals.recall / divisor,
      symbol_hit_rate: totals.symbolHits / divisor,
      ac_coverage: totals.acCoverage / divisor,
      false_positive_rate: totals.falsePositives / divisor,
      stale_candidate_rejection: staleRate,
      unauthorized_candidate_rejection: unauthorizedRate,
      stale_rejection_rate: staleRate,
      unauthorized_rejection_rate: unauthorizedRate,
      live_cache_parity: totals.liveCacheParity / divisor
    }
  };
}
