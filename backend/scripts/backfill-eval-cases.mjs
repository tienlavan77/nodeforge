// Backfills historical completed-ticket final reports into retrieval eval cases.
// Keeps the 11 curated cases in retrieval-cases.js untouched and regenerates
// retrieval-cases-auto.js from reports on disk, resuming by ticket_id.
// Usage: node backend/scripts/backfill-eval-cases.mjs [--ticket=TICKET-...] [--limit=N] [--dry-run]
import { existsSync } from "node:fs";
import { join } from "node:path";
import { collectAutoCases, writeAutoFile } from "../src/modules/eval/eval-case-store.js";

const root = new URL("../..", import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const TICKET_FILTER = args.ticket ? String(args.ticket) : null;
const LIMIT = Number(args.limit ?? 0);
const DRY_RUN = Object.hasOwn(args, "dry-run");

const { cases, stats } = collectAutoCases({
  root,
  ticketFilter: TICKET_FILTER,
  limit: LIMIT,
  exists: (path) => existsSync(path)
});
for (const missing of stats.missingFiles) console.log(`[backfill-eval] missing on disk: ${missing}`);
if (DRY_RUN) {
  console.log(`[backfill-eval] dry-run scanned=${stats.scanned} would_backfill=${stats.backfilled} skipped=${stats.skipped}`);
  for (const item of cases) console.log(`[backfill-eval] would_backfill ${item.id} (${item.ground_truth.length} files)`);
  process.exit(0);
}
const { path, count } = writeAutoFile({ root, cases });
console.log(`[backfill-eval] scanned=${stats.scanned} backfilled=${stats.backfilled} skipped=${stats.skipped} -> ${join(".", path.replace(root, ""))} (${count} cases)`);
