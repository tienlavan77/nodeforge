// Retrieval eval runner: recall@K / precision@K over real Forge tickets.
// Usage: node tests/eval/run-retrieval-eval.mjs [--case=ID] [--k=4,8] [--limit=8]
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createRetrievalDependencies } from "../../src/modules/index/retrieval-dependencies.js";
import { createRelevantTreeSelector } from "../../src/modules/index/relevant-tree.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";
import { selectEvalCandidates } from "./retrieval-eval-registry.js";
import { RETRIEVAL_EVAL_CASES } from "./retrieval-cases.js";

const root = new URL("../../..", import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const K_VALUES = String(args.k ?? "4,8").split(",").map(Number);
const LIMIT = Number(args.limit ?? 8);
const CASE_ID = args.case ? String(args.case) : null;
const CASES = CASE_ID ? RETRIEVAL_EVAL_CASES.filter((item) => item.id === CASE_ID) : RETRIEVAL_EVAL_CASES;
if (CASE_ID && CASES.length === 0) throw new Error(`Unknown retrieval eval case: ${CASE_ID}`);

const indexDb = await openIndexDatabase(root, { runtimeDir: ".forge/runtime/wc" });
const { search, fileGraph, embeddingStore, embeddingProvider } = createRetrievalDependencies({ database: indexDb });
const selector = createRelevantTreeSelector({ search, fileGraph, embeddingStore, embeddingProvider, maxFiles: 30, defaultDepth: 1 });
const registry = createForgeToolRegistry({ relevantTreeSelector: selector, protocolStorage: { get: async () => null }, fileService: { readForIndex: async () => null }, projectLogger: () => {} });

let hitsAt = Object.fromEntries(K_VALUES.map((k) => [k, 0]));
let precAt = Object.fromEntries(K_VALUES.map((k) => [k, 0]));
let hubTop = 0;
const rows = [];

for (const c of CASES) {
  const startedAt = Date.now();
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
  rows.push({ ...row, duration_ms: Date.now() - startedAt, semantic_matches: ranked.filter((path) => result.selected.find((entry) => entry.path === path)?.reason?.includes("tier-semantic:embedding")).length });
}

const n = CASES.length;
console.log(`cases=${n} limit=${LIMIT} K=${K_VALUES.join(",")}`);
for (const r of rows) {
  const scores = K_VALUES.map((k) => `R@${k}=${r[`recall@${k}`].toFixed(2)} P@${k}=${r[`precision@${k}`].toFixed(2)}`).join(" ");
  console.log(`${r.id} ${scores} duration_ms=${r.duration_ms} semantic=${r.semantic_matches} missing=[${r.missing.join(";")}]${r.hub_in_top2 ? ` HUB-TOP2=${r.hub_in_top2}` : ""}`);
}
for (const k of K_VALUES) console.log(`avg recall@${k}=${(hitsAt[k] / n).toFixed(3)} precision@${k}=${(precAt[k] / n).toFixed(3)}`);
console.log(`hub_in_top2=${hubTop}/${n}`);
await indexDb.close?.();
