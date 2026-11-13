// Snapshot candidate selection keeps Reviewer discovery on the exact committed source used for review.
// Retrieval scans the authorized pinned corpus and uses the shared lexical ranking rules.
// Live indexes, embeddings, candidate caches and freshness checks never supply ranking or metadata.
import { extractorRegistry } from "../../index/parser/index.js";
import { createRelevantTreeSelector } from "../../index/relevant-tree.js";
import { assertRoleFileAccess } from "../../../infrastructure/filesystem/file-service-role-policy.js";

// Business purpose: keeps Reviewer findings reproducible for the revision being assessed.
// Technical behavior: preserves the caller's supported method surface while implementing each
// variant using pinned lexical retrieval; semantic and freshness variants use this same corpus.
export function createSnapshotCandidateSelector({ relevantTreeSelector, source } = {}) {
  if (!relevantTreeSelector || typeof source?.listFiles !== "function" || typeof source?.readForIndex !== "function") {
    throw new TypeError("Snapshot candidate selection requires a tree selector and committed source.");
  }
  const methods = ["select", "selectFresh", "selectWithEmbeddings", "selectFreshWithEmbeddings"];
  return Object.freeze(Object.fromEntries(methods.filter((name) => typeof relevantTreeSelector[name] === "function")
    .map((name) => [name, select])));

  // Business purpose: prevents post-review edits or live-only hits from displacing valid candidates.
  // Technical behavior: reads authorized pinned files before ranking, then rebuilds every output field.
  async function select(args = {}) {
    const corpus = [];
    for (const path of [...new Set(await source.listFiles())].sort()) {
      try {
        assertRoleFileAccess("reviewer", "read", path);
        const file = await source.readForIndex({ path });
        const symbols = extractorRegistry.extract(path, file.content).symbols ?? [];
        corpus.push({ path, content: file.content, symbols });
      } catch (error) {
        // These paths cannot be read through the pinned Reviewer source and cannot be candidates.
        if (["FILE_ROLE_FORBIDDEN", "REVIEW_EVIDENCE_TOO_LARGE", "ENOENT", "NOT_FOUND"].includes(error?.code)) continue;
        throw error;
      }
    }
    const byPath = new Map(corpus.map((file) => [file.path, file]));
    const search = { search: searchPinned };
    const fileGraph = { getDependencies: () => ({ edges: [] }), getDependents: () => ({ edges: [] }) };
    const selector = createRelevantTreeSelector({ search, fileGraph });
    const result = selector.select({ ...args,
      allowedPaths: byPath.keys(),
      priorFiles: (args.priorFiles ?? args.prior_files ?? []).filter((entry) => byPath.has(typeof entry === "string" ? entry : entry?.path)),
      prior_files: [],
      dependencyFiles: (args.dependencyFiles ?? args.dependency_files ?? []).filter((entry) => byPath.has(typeof entry === "string" ? entry : entry?.path)),
      dependency_files: []
    });
    return {
      ...result,
      index_version: source.reviewCommit,
      tree: result.tree.filter((entry) => byPath.has(entry.path)).map((entry) => ({
        path: entry.path, score: entry.score, reason: entry.reason, reasons: entry.reason,
        relations: [], node: { path: entry.path, index_version: source.reviewCommit },
        confidence: "static", matched_symbols: byPath.get(entry.path).symbols
      }))
    };

    // Business purpose: finds review evidence in pinned bytes without consulting a live search index.
    // Technical behavior: scores path, symbol and content matches deterministically before limiting.
    function searchPinned({ query, kind, limit }) {
      const terms = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
      const matches = corpus.map((file) => {
        const text = (kind === "file" ? file.path : kind === "symbol"
          ? file.symbols.map((symbol) => [symbol.name, symbol.summary].filter(Boolean).join(" ")).join(" ")
          : file.content).toLowerCase();
        const score = terms.reduce((total, term) => total + Number(text.includes(term)), 0);
        return { path: file.path, node: { path: file.path, index_version: source.reviewCommit },
          score, reason: ["snapshot:" + kind] };
      }).filter((match) => match.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      return { matches: matches.slice(0, limit) };
    }
  }
}
