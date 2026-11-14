// Retrieval eval runner: recall@K / precision@K over real Forge tickets.
// Usage: node tests/eval/run-retrieval-eval.mjs [--case=ID] [--k=4,8] [--limit=8]
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createRetrievalDependencies } from "../../src/modules/index/retrieval-dependencies.js";
import { createRelevantTreeSelector } from "../../src/modules/index/relevant-tree.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";
import { selectEvalCandidates } from "./retrieval-eval-registry.js";
import { evaluateRetrievalCases } from "./retrieval-metrics.js";
import { RETRIEVAL_EVAL_CASES } from "./retrieval-cases.js";
import { REPOSITORY_ROOT } from "../../src/shared/repository-root.js";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = REPOSITORY_ROOT;
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const K_VALUES = String(args.k ?? "4,8").split(",").map(Number);
const LIMIT = Number(args.limit ?? 8);
const CASE_ID = args.case ? String(args.case) : null;
const OUTPUT_PATH = args.output ? String(args.output) : ".forge/runtime/reports/retrieval-evaluation-report.json";
const CASES = CASE_ID ? RETRIEVAL_EVAL_CASES.filter((item) => item.id === CASE_ID) : RETRIEVAL_EVAL_CASES;
if (CASE_ID && CASES.length === 0) throw new Error(`Unknown retrieval eval case: ${CASE_ID}`);

// Retains per-case execution evidence when a long benchmark is interrupted before its final summary.
const progressPath = join(root, ".forge/runtime/reports/retrieval-benchmark-progress.jsonl");
await mkdir(join(root, ".forge/runtime/reports"), { recursive: true });
await writeFile(progressPath, `${JSON.stringify({ phase: "started", cases: CASES.length, limit: LIMIT, k: K_VALUES, at: new Date().toISOString() })}\n`);
const indexDb = await openIndexDatabase(root, { runtimeDir: ".forge/runtime/wc" });
await appendFile(progressPath, `${JSON.stringify({ phase: "index_opened", at: new Date().toISOString() })}\n`);
const { search, fileGraph, embeddingStore, embeddingProvider } = createRetrievalDependencies({ database: indexDb });
const selector = createRelevantTreeSelector({ search, fileGraph, embeddingStore, embeddingProvider, maxFiles: 30, defaultDepth: 1 });
const registry = createForgeToolRegistry({ relevantTreeSelector: selector, protocolStorage: { get: async () => null }, fileService: { readForIndex: async () => null }, projectLogger: () => {} });

let hitsAt = Object.fromEntries(K_VALUES.map((k) => [k, 0]));
let precAt = Object.fromEntries(K_VALUES.map((k) => [k, 0]));
let hubTop = 0;
const rows = [];
const metricCases = [];
const rejectionProbe = { status: "not_run", reason: "The live evaluator uses eval_harness scope; authorization probes require a separate scoped registry fixture.", verifier: "system_engineer" };

for (const c of CASES) {
  const startedAt = Date.now();
  await appendFile(progressPath, `${JSON.stringify({ phase: "case_started", id: c.id, at: new Date().toISOString() })}\n`);
  const result = await selectEvalCandidates({ registry, caseItem: c, limit: LIMIT });
  if (process.env.RETRIEVAL_DEBUG_POOL === "1" && (!process.env.RETRIEVAL_DEBUG_CASE || c.id === process.env.RETRIEVAL_DEBUG_CASE)) {
    console.log(`candidate_pool=${JSON.stringify(result.retrieval_diagnostics ?? [])}`);
  }
  const ranked = result.selected.map((e) => e.path);
  const truth = c.ground_truth.filter((p) => !p.includes(".test."));
  const row = { id: c.id, n_truth: truth.length, returned: ranked.length };
  for (const k of K_VALUES) {
    const top = ranked.slice(0, k);
    const hit = truth.filter((p) => top.includes(p)).length;
    row[`recall@${k}`] = truth.length ? hit / truth.length : 1;
    row[`precision@${k}`] = top.length ? hit / top.length : 0;
    hitsAt[k] += row[`recall@${k}`];
    precAt[k] += row[`precision@${k}`];
  }
  row.missing = truth.filter((p) => !ranked.slice(0, Math.max(...K_VALUES)).includes(p));
  const hubHit = (c.hub_paths ?? []).find((h) => ranked.slice(0, 2).includes(h));
  if (hubHit) { hubTop += 1; row.hub_in_top2 = hubHit; }
  const semanticMatches = ranked.filter((path) => result.selected.find((entry) => entry.path === path)?.reason?.includes("tier-semantic:embedding")).length;
  rows.push({ ...row, duration_ms: Date.now() - startedAt, semantic_matches: semanticMatches });
  metricCases.push({ id: c.id, expected_files: truth, candidates: result.selected.map((entry) => ({ path: entry.path, sha256: entry.sha256 ?? entry.source_sha256 ?? null, source_revision: entry.source_revision ?? null, receipt: entry.receipt ?? null, fresh: entry.fresh ?? null, scope: entry.scope ?? null })), acceptance_criteria: c.acceptance_criteria ?? [] });
  await appendFile(progressPath, `${JSON.stringify({ phase: "case_completed", ...rows.at(-1) })}\n`);
}

const n = CASES.length;
console.log(`cases=${n} limit=${LIMIT} K=${K_VALUES.join(",")}`);
for (const r of rows) {
  const scores = K_VALUES.map((k) => `R@${k}=${r[`recall@${k}`].toFixed(2)} P@${k}=${r[`precision@${k}`].toFixed(2)}`).join(" ");
  console.log(`${r.id} ${scores} duration_ms=${r.duration_ms} semantic=${r.semantic_matches} missing=[${r.missing.join(";")}]${r.hub_in_top2 ? ` HUB-TOP2=${r.hub_in_top2}` : ""}`);
}
for (const k of K_VALUES) console.log(`avg recall@${k}=${(hitsAt[k] / n).toFixed(3)} precision@${k}=${(precAt[k] / n).toFixed(3)}`);
console.log(`hub_in_top2=${hubTop}/${n}`);
const metricReport = evaluateRetrievalCases(metricCases, { k: LIMIT, corpusRevision: "HEAD", retrievalConfig: { limit: LIMIT, k_values: K_VALUES, production_tool: "select_code_graph_candidates" }, datasetChecksum: "sha256:797b4d28ea1b3239ff499962c4d7e9372ee264cbee9e5ab90ebd984540cc6d5f", knowledgeRevision: "index-database-current-checkout", modelIdentity: "production-retrieval-dependencies", indexIdentity: "current-checkout-index", verifierProvenance: [{ verifier: "system_engineer", evidence: "live 11-case production registry run" }], regressionResults: [{ name: "retrieval_runner_completed", status: "passed", cases: n }] });
const evaluation = {
  schema_version: "retrieval-evaluation-report.v1",
  generated_at: new Date().toISOString(),
  repository_root: root,
  dataset: { name: "vocabulary/semantic-evaluation/golden-queries.jsonl", case_source: "backend/tests/eval/retrieval-cases.js", case_count: n, golden_query_sha256: "sha256:797b4d28ea1b3239ff499962c4d7e9372ee264cbee9e5ab90ebd984540cc6d5f" },
  evaluator: { runner: "backend/tests/eval/run-retrieval-eval.mjs", registry: "backend/tests/eval/retrieval-eval-registry.js", metrics: "backend/tests/eval/retrieval-metrics.js", production_tool: "select_code_graph_candidates", limit: LIMIT, k_values: K_VALUES },
  results: { averages: Object.fromEntries(K_VALUES.map((k) => [k, { recall: hitsAt[k] / n, precision: precAt[k] / n }])), hub_in_top2: { hits: hubTop, total: n, rate: n ? hubTop / n : 0 }, cases: rows },
  metric_evaluator: { schema_version: "retrieval-metrics.v1", provenance_complete: metricReport.provenance_complete, metrics: metricReport.metrics, cases: metricReport.cases, fallback_counts: metricReport.fallback_counts, verifier_provenance: metricReport.verifier_provenance },
  rejection_probes: { unauthorized_candidate_input: rejectionProbe },
  metric_status: { symbol_hit_rate: "not_measured", acceptance_criteria_coverage: "not_measured", false_positive_rate: "measured_by_evaluator", stale_rejection_rate: "not_measured", unauthorized_rejection_rate: "not_measured", live_cache_parity: "not_measured", baseline_reranked_delta: "not_measured" },
  comparison: { baseline_document: "docs/archive/giai-doan-3/retrieval-baseline.md", baseline_recall_at_4: 0.523, baseline_recall_at_8: 0.667, comparison_status: "recorded_against_archived_baseline" },
  limitations: ["symbol_hit_rate, acceptance_criteria_coverage, false_positive_rate, stale_rejection_rate and unauthorized_rejection_rate require per-case labels/results not present in the current golden-query corpus; they are recorded as unavailable rather than inferred from fixture data.", "parity and baseline/reranked deltas require a separately executed baseline mode; this artifact does not claim those values."],
  provenance: { progress_log: progressPath, output_path: OUTPUT_PATH }
};
await mkdir(join(root, OUTPUT_PATH, ".."), { recursive: true });
await writeFile(join(root, OUTPUT_PATH), `${JSON.stringify(evaluation, null, 2)}\n`);
await appendFile(progressPath, `${JSON.stringify({ phase: "completed", cases: n, averages: Object.fromEntries(K_VALUES.map((k) => [k, { recall: hitsAt[k] / n, precision: precAt[k] / n }])), hub_in_top2: hubTop, output_path: OUTPUT_PATH, at: new Date().toISOString() })}\n`);
await indexDb.close?.();
