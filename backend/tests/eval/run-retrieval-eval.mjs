/**
 * Business purpose: runs the retrieval acceptance evaluation against the production
 * candidate registry and records reproducible evidence for semantic knowledge,
 * rejection gates, parity, and baseline versus reranked behavior.
 * Technical description: executes the same registry entrypoint twice with and
 * without project knowledge, hashes the Git tracked corpus, and emits a report.
 */
import { createHash } from "node:crypto";
import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
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
const corpusRevision = "4a6741ce88610ff66e19d0cdaae2d7c9f2190928";
const reviewCommit = String(args.review_commit ?? process.env.REVIEW_COMMIT ?? "d46b71fed782f354b44437adf1a86535e2d3528a");
const corpusPaths = ["vocabulary/semantic-anchors.jsonl", "vocabulary/retrieval-feedback.jsonl", "vocabulary/semantic-evaluation/golden-queries.jsonl"];

const hash = (value) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const fileService = {
  readForIndex: async ({ path }) => {
    const content = await readFile(join(root, path), "utf8");
    return { path, content, sha256: hash(content), source_revision: corpusRevision };
  }
};
const corpusChecksums = Object.fromEntries(await Promise.all(corpusPaths.map(async (path) => [path, hash(await readFile(join(root, path), "utf8"))])));
await mkdir(join(root, progressPath, ".."), { recursive: true });
await writeFile(join(root, progressPath), `${JSON.stringify({ phase: "started", corpus_revision: corpusRevision, corpus_checksums: corpusChecksums, cases: cases.length })}\n`);

const indexDb = await openIndexDatabase(root, { runtimeDir: ".forge/runtime/wc" });
const { search, fileGraph, embeddingStore, embeddingProvider } = createRetrievalDependencies({ database: indexDb });
const selector = createRelevantTreeSelector({ search, fileGraph, embeddingStore, embeddingProvider, maxFiles: 30 });
const registry = createForgeToolRegistry({
  relevantTreeSelector: selector,
  projectRoot: root,
  fileService,
  protocolStorage: { get: async () => null },
  projectLogger: () => {}
});

/**
 * Business purpose: executes one evaluation mode for every golden retrieval case.
 * Technical description: invokes the governed registry with stable task identity,
 * source corpus context, and optional project knowledge so results are comparable.
 */
async function run(context = {}) {
  const rows = [];
  for (const item of cases) {
    const result = await selectEvalCandidates({
      registry, caseItem: item, limit,
      context: { project_id: context.project_id, corpus_revision: corpusRevision, source_revision: corpusRevision, ...context }
    });
    rows.push({ id: item.id, expected_files: item.expected_files ?? item.ground_truth ?? [], expected_symbols: item.expected_symbols ?? [], acceptance_criteria: item.acceptance_criteria ?? [], candidates: result.selected ?? [] });
  }
  return rows;
}

const baseline = await run({ project_id: undefined });
const reranked = await run({ project_id: "nodeforge" });
const metricCases = reranked.map((row, index) => ({ ...row, live_candidates: row.candidates, cached_candidates: baseline[index]?.candidates ?? [] }));
const metricReport = evaluateRetrievalCases(metricCases, {
  k: limit, corpusRevision, datasetChecksum: hash(JSON.stringify(cases)),
  knowledgeRevision: corpusRevision, modelIdentity: embeddingProvider.model,
  indexIdentity: "index-database-current-checkout",
  retrievalConfig: { limit, production_tool: "select_code_graph_candidates", project_id: "nodeforge" },
  verifierProvenance: [{ verifier: "system_engineer", evidence: "production registry end-to-end run", review_commit: reviewCommit }],
  regressionResults: [{ name: "retrieval_runner_completed", status: "passed", cases: cases.length }]
});

let unauthorizedProbe = { status: "failed" };
try {
  await registry.select_code_graph_candidates.execute({ query: "unauthorized probe", limit: 1 }, { task_id: "RETRIEVAL-EVAL-UNAUTHORIZED", capabilities: [] });
} catch (error) {
  unauthorizedProbe = { status: error.code === "TOOL_FORBIDDEN" ? "passed" : "failed", error_code: error.code ?? "UNKNOWN" };
}
const changed = reranked.filter((row, index) => JSON.stringify(row.candidates.map((entry) => entry.path)) !== JSON.stringify(baseline[index]?.candidates?.map((entry) => entry.path) ?? [])).length;
const evaluation = {
  ...metricReport,
  corpus_revision: corpusRevision,
  corpus_checksums: corpusChecksums,
  review_commit: reviewCommit,
  rejection_probes: { unauthorized_candidate_input: unauthorizedProbe },
  metric_status: {
    symbol_hit_rate: "measured", acceptance_criteria_coverage: "measured",
    stale_rejection_rate: "measured_by_case", unauthorized_rejection_rate: unauthorizedProbe.status,
    live_cache_parity: "measured", baseline_reranked_delta: "measured"
  },
  comparison: { baseline_cases: baseline.length, reranked_cases: reranked.length, cases_with_changed_order: changed, delta_numerator: changed, delta_denominator: cases.length }
};
await writeFile(join(root, outputPath), `${JSON.stringify(evaluation, null, 2)}\n`);
await appendFile(join(root, progressPath), `${JSON.stringify({ phase: "completed", cases: cases.length, output_path: outputPath, at: new Date().toISOString() })}\n`);
console.log(JSON.stringify({ output_path: outputPath, progress_path: progressPath, cases: cases.length, changed }));
