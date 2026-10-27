// Converts existing index entries through the accepted incremental extraction path.
// This bounded scan never rewrites source or treats a failed read as a deletion:
// durable per-file receipts allow restarts to resume only unconverted versions.
import { createIncrementalIndexer } from "./incremental-indexer.js";
import { createSummaryConversion } from "./purpose-summary-conversion.js";

// Backfills existing source snapshots without a destructive rebuild or duplicate
// extraction contract. Detailed outcomes retain read/parse failures for operators;
// only committed conversions receive receipts from the normal index transaction.
export async function backfillPurposeSummaries({ database, projectRoot, indexer, ...options }) {
  const conversion = createSummaryConversion(database);
  const worker = indexer ?? createIncrementalIndexer({ database, projectRoot, ...options });
  const results = [];
  for (const file of database.all("SELECT file_id, path, sha256 FROM files ORDER BY path")) {
    if (!conversion.needed(file)) {
      results.push({ path: file.path, status: "unchanged", committed: false });
      continue;
    }
    results.push(await worker.handleDetailed({ type: "watcher.file_modified", payload: { path: file.path } }));
  }
  return { succeeded: results.every((result) => result.status !== "failed"), results };
}
