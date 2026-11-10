// Snapshot candidate selection keeps Reviewer discovery on the exact committed source used for review.
// It filters live index results to pinned paths and reconstructs metadata from pinned bytes so review
// findings cannot be influenced by files, symbols, or graph relations introduced after the review commit.
import { extractorRegistry } from "../../index/parser/index.js";

// Business purpose: keeps Reviewer candidate findings bound to the revision being assessed.
// Technical behavior: wraps every retrieval variant, removes paths absent from the committed source, and rebuilds symbol and relation metadata from pinned bytes.
export function createSnapshotCandidateSelector({ relevantTreeSelector, source } = {}) {
  if (!relevantTreeSelector || typeof source?.listFiles !== "function" || typeof source?.readForIndex !== "function") {
    throw new TypeError("Snapshot candidate selection requires a tree selector and committed source.");
  }
  return Object.freeze({
    select: (args) => bind(relevantTreeSelector.select(args)),
    selectFresh: (args) => bind(relevantTreeSelector.selectFresh(args)),
    selectWithEmbeddings: (args) => bind(relevantTreeSelector.selectWithEmbeddings(args)),
    selectFreshWithEmbeddings: (args) => bind(relevantTreeSelector.selectFreshWithEmbeddings(args))
  });

  // Rebuilds candidate metadata from committed bytes while preserving the selector's bounded ranking.
  async function bind(resultPromise) {
    const result = await resultPromise;
    const committedPaths = new Set(await source.listFiles());
    const tree = [];
    for (const entry of result?.tree ?? []) {
      if (!committedPaths.has(entry?.path)) continue;
      try {
        const file = await source.readForIndex({ path: entry.path });
        const symbols = extractorRegistry.extract(entry.path, file.content).symbols ?? [];
        tree.push({
          ...entry,
          relations: [],
          node: { ...(entry.node ?? {}), path: entry.path, relations: [] },
          matched_symbols: symbols
        });
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "NOT_FOUND") continue;
        throw error;
      }
    }
    return { ...result, tree };
  }
}
