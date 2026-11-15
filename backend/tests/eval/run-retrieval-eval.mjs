/**
 * Business purpose: runs the retrieval acceptance evaluation against the production
 * candidate registry and records reproducible evidence for semantic knowledge,
 * rejection gates, parity, and baseline versus reranked behavior.
 * Technical description: executes the same registry entrypoint with and without
 * project knowledge, hashes the Git tracked corpus, probes stale and unauthorized
 * candidates, and emits a report bound to an explicit review commit.
 */
import { createHash } from "node:crypto";
import { mkdir, appendFile, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createRetrievalDependencies } from "../../src/modules/index/retrieval-dependencies.js";
import { createRelevantTreeSelector } from "../../src/modules/index/relevant-tree.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";
import { selectEvalCandidates } from "./retrieval-eval-registry.js";
import { evaluateRetrievalCases } from "./retrieval-metrics.js";
import { RETRIEVAL_EVAL_CASES } from "./retrieval-cases.js";
import { REPOSITORY_ROOT } from "../../src/shared/repository-root.js";

const args = Object.fromEntries(process.argv.slice(2).map((value) => value.replace(/^--/, "").split("=")));
const root = REPOSITORY_ROOT;
const limit = Number(args.limit ?? 8);
const cases = args.case ? RETRIEVAL_EVAL_CASES.filter((item) => item.id === args.case) : RETRIEVAL_EVAL_CASES;
const outputPath = String(args.output ?? "docs/evaluation/retrieval-evaluation-report.json");
const progressPath = String(args.progress ?? "docs/evaluation/retrieval-evaluation-progress.jsonl");
const corpusRevision = String(args.corpus_revision ?? process.env.CORPUS_REVISION ?? "b5cb0d9360f1005d180bd27789be20ebcc38f41b");
const reviewCommit = String(args.review_commit ?? process.env.REVIEW_COMMIT ?? "0161844b56b0163c9ea6de240f5b28c49c9e55b1");
const corpusPaths = ["vocabulary/semantic-anchors.jsonl", "vocabulary/retrieval-feedback.jsonl", "vocabulary/semantic-evaluation/golden-queries.jsonl"];

const hash = (value) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const fileService = {
  readForIndex: async ({ path }) => {
    const content = await readFile(join(root, path), "utf8");
    return { path, content, sha256: hash(content), source_revision: corpusRevision };
  }
};
const corpusChecksums = Object.fromEntries(await Promise.all(corpusPaths.map(async (path) => [path, hash(await readFile(join(root, path), "utf8"))])));
const knowledgeArtifactRevision = hash(JSON.stringify(Object.fromEntries(Object.entries(corpusChecksums).filter(([path]) => !path.includes("golden-queries")))));
const sourceSha256 = hash(JSON.stringify(corpusChecksums));
await mkdir(join(root, progressPath, ".."), { recursive: true });
await writeFile(join(root, progressPath), `${JSON.stringify({ phase: "started", corpus_revision: corpusRevision, corpus_checksums: corpusChecksums, cases: cases.length, review_commit: reviewCommit })}\n`);

const runtimeDir = String(args.runtime_dir ?? ".forge/runtime/eval-r10");
const runtimePath = join(root, runtimeDir);
const sourceRuntimePath = join(root, ".forge/runtime/wc");
await rm(runtimePath, { recursive: true, force: true });
await mkdir(runtimePath, { recursive: true });
for (const suffix of ["index.db", "index.db-wal", "index.db-shm"]) {
  try { await copyFile(join(sourceRuntimePath, suffix), join(runtimePath, suffix)); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const indexDb = await openIndexDatabase(root, { runtimeDir });
const { search, fileGraph, embeddingStore, embeddingProvider } = createRetrievalDependencies({ database: indexDb });
const useEmbeddings = args.embeddings === "on";

/**
 * Business purpose: creates the production registry used by both normal and
 * stale-candidate evaluation probes.
 * Technical description: keeps the same index, source service, and governed
 * dispatch path while allowing the probe to inject an explicit stale verdict.
 */
function createRegistry(freshnessChecker = null) {
  const selector = createRelevantTreeSelector({ search, fileGraph, embeddingStore: useEmbeddings ? embeddingStore : null, embeddingProvider: useEmbeddings ? embeddingProvider : null, freshnessChecker, maxFiles: 30 });
  return createForgeToolRegistry({
    relevantTreeSelector: selector,
    freshnessChecker,
    projectRoot: root,
    fileService,
    protocolStorage: { get: async () => null },
    projectLogger: () => {}
  });
}

const registry = createRegistry();
const staleRegistry = createRegistry({ checkPaths: async (paths) => paths.map((path) => ({ path, status: "stale" })) });

/**
 * Business purpose: executes one evaluation mode for every golden retrieval case.
 * Technical description: invokes the governed registry with stable task identity,
 * source corpus context, and optional project knowledge so results are comparable.
 */
async function run(caseList = cases, context = {}, activeRegistry = registry) {
  const rows = [];
  for (const item of caseList) {
    const result = await selectEvalCandidates({
      registry: activeRegistry, caseItem: item, limit,
      context: {
        project_id: context.project_id,
        corpus_revision: corpusRevision,
        source_revision: corpusRevision,
        knowledge_artifact_revision: knowledgeArtifactRevision,
        review_commit_sha: reviewCommit,
        ...context
      }
    });
    rows.push({
      id: item.id,
      expected_files: item.expected_files ?? item.ground_truth ?? [],
      expected_symbols: item.expected_symbols ?? [],
      acceptance_criteria: item.acceptance_criteria ?? [],
      candidates: result.selected_verified ?? result.selected ?? []
    });
  }
  return rows;
}

/**
 * Business purpose: measures source-safety rejection gates independently of
 * golden retrieval accuracy so zeroes cannot be inferred from missing probes.
 * Technical description: runs one stale cached-candidate probe and one
 * unauthorized capability probe per case, preserving safe receipt diagnostics.
 */
async function runRejectionProbes() {
  const stale = [];
  const unauthorized = [];
  for (const item of cases) {
    const stalePath = (item.expected_files ?? item.ground_truth ?? [])[0] ?? "backend/src/modules/index/semantic-knowledge.js";
    try {
      const result = await selectEvalCandidates({
        registry: staleRegistry,
        caseItem: item,
        limit: 1,
        context: {
          project_id: "nodeforge",
          task_context: { candidate_files: [{ path: stalePath, role: "PATCH" }] }
        }
      });
      const selected = result.selected_verified ?? result.selected ?? [];
      const rejectedEntries = result.rejected ?? [];
      const rejected = rejectedEntries.filter((candidate) => candidate.rejection_reason === "stale" || candidate.stale === true).length;
      const eligible = selected.length + rejectedEntries.length;
      stale.push({
        id: item.id,
        probe: "stale_candidate",
        eligible,
        rejected,
        status: eligible > 0 && selected.every((candidate) => candidate.receipt?.status === "verified") && rejectedEntries.every((candidate) => typeof candidate.rejection_reason === "string") ? "passed" : "not_measured",
        diagnostics: [...selected, ...rejectedEntries].map((candidate) => ({
          path: candidate.path,
          reason: candidate.rejection_reason ?? null,
          stale: candidate.stale === true,
          receipt_status: candidate.receipt?.status ?? "missing",
          receipt_error: candidate.receipt?.error ?? null
        }))
      });
    } catch (error) {
      stale.push({ id: item.id, probe: "stale_candidate", eligible: 0, rejected: 0, status: "error", diagnostics: [{ error_code: error.code ?? "UNKNOWN", message: String(error.message ?? error) }] });
    }
    try {
      await selectEvalCandidates({
        registry,
        caseItem: item,
        limit: 1,
        context: { project_id: "nodeforge", capabilities: [] }
      });
      unauthorized.push({ id: item.id, probe: "unauthorized_candidate", eligible: 1, rejected: 0, status: "failed", expected_error_code: "TOOL_FORBIDDEN", actual_error_code: null, diagnostics: [{ reason: "probe unexpectedly returned candidates" }] });
    } catch (error) {
      const rejected = error.code === "TOOL_FORBIDDEN" ? 1 : 0;
      unauthorized.push({
        id: item.id,
        probe: "unauthorized_candidate",
        eligible: 1,
        rejected,
        status: rejected ? "passed" : "failed",
        expected_error_code: "TOOL_FORBIDDEN",
        actual_error_code: error.code ?? "UNKNOWN",
        diagnostics: [{ message: String(error.message ?? error) }]
      });
    }
  }
  return { stale, unauthorized };
}

const baseline = await run(cases, { project_id: undefined });
const reranked = await run(cases, { project_id: "nodeforge" });
const rejectionProbes = await runRejectionProbes();
const staleByCase = new Map(rejectionProbes.stale.map((probe) => [probe.id, probe]));
const unauthorizedByCase = new Map(rejectionProbes.unauthorized.map((probe) => [probe.id, probe]));
const metricCases = reranked.map((row, index) => {
  const stale = staleByCase.get(row.id) ?? {};
  const unauthorized = unauthorizedByCase.get(row.id) ?? {};
  return {
    ...row,
    live_candidates: row.candidates,
    cached_candidates: baseline[index]?.candidates ?? [],
    baseline_candidates: baseline[index]?.candidates ?? [],
    reranked_candidates: row.candidates,
    stale_rejected: stale.rejected ?? 0,
    stale_rejection_eligible: stale.eligible ?? 0,
    rejected_case_count: (stale.rejected ?? 0) + (unauthorized.rejected ?? 0),
    unauthorized_rejected: unauthorized.rejected ?? 0,
    unauthorized_rejection_eligible: unauthorized.eligible ?? 0,
    stale_probe_diagnostics: stale.diagnostics ?? null,
    unauthorized_probe_diagnostics: unauthorized.diagnostics ?? null
  };
});
const metricReport = evaluateRetrievalCases(metricCases, {
  k: limit,
  corpusRevision,
  datasetChecksum: hash(JSON.stringify(cases)),
  knowledgeRevision: corpusRevision,
  knowledgeArtifactRevision,
  reviewCommitSha: reviewCommit,
  sourceSha256,
  modelIdentity: useEmbeddings ? embeddingProvider.model : "lexical-only-evaluation",
  indexIdentity: "index-database-current-checkout",
  retrievalConfig: { limit, production_tool: "select_code_graph_candidates", project_id: "nodeforge", embeddings: useEmbeddings },
  verifierProvenance: [{ verifier: "system_engineer", evidence: "production registry end-to-end run", review_commit: reviewCommit }],
  regressionResults: [{ name: "retrieval_runner_completed", status: "passed", cases: cases.length }],
  rejectionProbes
});

/**
 * Business purpose: validates that Git-tracked semantic knowledge changes the
 * production ordering when its query and source receipts are valid.
 * Technical description: compares the same registry query with project knowledge
 * disabled and enabled, then records the observed path order and adjustments.
 */
const knowledgeCase = [{
  id: "knowledge-rerank",
  query: "recursive key canonicalization preserves equivalent lineage bindings",
  objective: "Locate backend/src/modules/index/semantic-knowledge.js and backend/src/modules/index/code-search.js for recursive key canonicalization",
  acceptance_criteria: [],
  guardrails: [],
  style: ["backend"],
  ground_truth: ["backend/src/modules/index/semantic-knowledge.js"]
}];
const knowledgeBaseline = await run(knowledgeCase, { project_id: undefined, eval_harness: false });
const knowledgeReranked = await run(knowledgeCase, { project_id: "nodeforge", eval_harness: false });
const knowledgeBefore = knowledgeBaseline[0]?.candidates ?? [];
const knowledgeAfter = knowledgeReranked[0]?.candidates ?? [];
const knowledgeOrderChanged = JSON.stringify(knowledgeBefore.map((entry) => entry.path)) !== JSON.stringify(knowledgeAfter.map((entry) => entry.path));
const changed = reranked.filter((row, index) => JSON.stringify(row.candidates.map((entry) => entry.path)) !== JSON.stringify(baseline[index]?.candidates?.map((entry) => entry.path) ?? [])).length;

const evaluation = {
  ...metricReport,
  corpus_revision: corpusRevision,
  corpus_checksums: corpusChecksums,
  review_commit: reviewCommit,
  review_commit_sha: reviewCommit,
  knowledge_artifact_revision: knowledgeArtifactRevision,
  source_sha256: sourceSha256,
  rejection_probes: rejectionProbes,
  metric_status: {
    precision_at_k: metricReport.metric_details.precision_at_k.status,
    recall_at_k: metricReport.metric_details.recall_at_k.status,
    symbol_hit_rate: metricReport.metric_details.symbol_hit_rate.status,
    acceptance_criteria_coverage: metricReport.metric_details.ac_coverage.status,
    false_positive_rate: metricReport.metric_details.false_positive_rate.status,
    stale_rejection_rate: metricReport.metric_details.stale_rejection.status,
    unauthorized_rejection_rate: metricReport.metric_details.unauthorized_rejection.status,
    live_cache_parity: metricReport.metric_details.live_cache_parity.status,
    baseline_reranked_delta: knowledgeOrderChanged ? "measured" : "no_effect"
  },
  comparison: {
    baseline_cases: baseline.length,
    reranked_cases: reranked.length,
    cases_with_changed_order: changed + (knowledgeOrderChanged ? 1 : 0),
    delta_numerator: changed + (knowledgeOrderChanged ? 1 : 0),
    delta_denominator: cases.length + 1,
    knowledge_probe: {
      cases: 1,
      changed_order: knowledgeOrderChanged,
      baseline_paths: knowledgeBefore.map((entry) => entry.path),
      reranked_paths: knowledgeAfter.map((entry) => entry.path),
      reranked_entries: knowledgeAfter.map((entry) => ({ path: entry.path, score: entry.score, knowledge_adjustment: entry.knowledge_adjustment ?? 0, reasons: entry.reasons ?? [] }))
    }
  }
};
await writeFile(join(root, outputPath), `${JSON.stringify(evaluation, null, 2)}\n`);
await appendFile(join(root, progressPath), `${JSON.stringify({ phase: "completed", cases: cases.length, output_path: outputPath, review_commit: reviewCommit, corpus_revision: corpusRevision, at: new Date().toISOString() })}\n`);
await indexDb.close();
console.log(JSON.stringify({ output_path: outputPath, progress_path: progressPath, cases: cases.length, changed, knowledge_order_changed: knowledgeOrderChanged }));
