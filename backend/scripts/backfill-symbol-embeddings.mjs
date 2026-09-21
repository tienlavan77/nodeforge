// One-shot backfill: embed all indexed symbols missing vectors (or stale checksum).
// Reuses the same per-symbol text + checksum rule as the Watcher hook.
// Usage: node backend/scripts/backfill-symbol-embeddings.mjs [--limit=N] [--model=embeddinggemma] [--timeout=120000] [--retries=1]
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import readline from "node:readline";
import { createRetrievalDependencies } from "../src/modules/index/retrieval-dependencies.js";

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const modelArg = args.find((a) => a.startsWith("--model="));
const timeoutArg = args.find((a) => a.startsWith("--timeout="));
const retriesArg = args.find((a) => a.startsWith("--retries="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 0;
const MODEL_OVERRIDE = modelArg ? modelArg.split("=")[1] : undefined;
const TIMEOUT_OVERRIDE = timeoutArg ? Number(timeoutArg.split("=")[1]) : undefined;
const RETRIES = retriesArg ? Number(retriesArg.split("=")[1]) : 1;

const projectRoot = process.cwd();
const dbPath = join(projectRoot, ".forge", "runtime", "wc", "index.db");
const raw = new DatabaseSync(dbPath);
const database = {
  all: (sql, params = []) => raw.prepare(sql).all(...params).map((row) => ({ ...row })),
  run: (sql, params = []) => raw.prepare(sql).run(...params)
};

const { embeddingStore: store, embeddingProvider: provider, ollamaConfig } = createRetrievalDependencies({ database, ollamaConfig: { model: MODEL_OVERRIDE, timeoutMs: TIMEOUT_OVERRIDE } });
const MODEL = ollamaConfig.model;
const INPUT_LIMIT = MODEL === "all-minilm" ? 400 : 4000;

const symbols = database.all(
  `SELECT s.symbol_id, s.name, s.kind, f.path,
          COALESCE(sc.content, '') AS content,
          e.content_checksum AS stored_checksum, e.embedding_model AS stored_model
   FROM symbols s
   JOIN files f ON f.file_id = s.file_id
   LEFT JOIN symbol_content_fts sc ON sc.symbol_id = s.symbol_id
   LEFT JOIN symbol_embeddings e ON e.symbol_id = s.symbol_id
   ORDER BY f.path, s.start_line`
);

let done = 0;
let skipped = 0;
let failed = 0;
const queue = LIMIT > 0 ? symbols.slice(0, LIMIT) : symbols;
const total = (LIMIT > 0 ? ` (of ${symbols.length} total)` : "");
console.log(`Backfill: ${queue.length} symbols to process${total} (model=${MODEL}).`);
const started = Date.now();

// Two-line progress display redrawn in place via readline cursor control.
// Line 1 is the bar plus percent; line 2 shows the current symbol on the left
// and the counters on the right. Lines stay one column short of full width so
// no terminal wraps and pushes the cursor off. Falls back to plain log lines
// when stdout is not a TTY (piped logs).
let currentLabel = "";
let barDrawn = false;
function renderBar(processed) {
  const ratio = processed / queue.length;
  const pct = (ratio * 100).toFixed(2);
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  if (!process.stdout.isTTY) {
    if (processed % 50 === 0 || processed === queue.length) {
      console.log(`[${processed}/${queue.length} ${pct}% ${elapsed}s] done=${done} skipped=${skipped} failed=${failed} last=${currentLabel}`);
    }
    return;
  }
  const width = (process.stdout.columns ?? 80) - 1;
  const right = `[${processed}/${queue.length} ${elapsed}s] done=${done} skipped=${skipped} failed=${failed}`;
  const maxLabel = Math.max(10, width - right.length - 1);
  const label = currentLabel.length > maxLabel ? `\u2026${currentLabel.slice(-(maxLabel - 1))}` : currentLabel;
  const barWidth = Math.max(10, width - pct.length - 1);
  const filled = Math.min(barWidth, Math.round(ratio * barWidth));
  const line1 = `${"\u2588".repeat(filled)}${"\u2591".repeat(barWidth - filled)} ${pct}%`;
  const gap = Math.max(0, width - label.length - right.length);
  const line2 = `${label}${" ".repeat(gap)}${right}`;
  if (barDrawn) readline.moveCursor(process.stdout, 0, -1);
  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(`${line1}\n`);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(line2);
  barDrawn = true;
  if (processed === queue.length) process.stdout.write("\n");
}

for (const sym of queue) {
  const checksum = checksumText(`${sym.name}\n${sym.kind}\n${sym.content ?? ""}`);
  if (sym.stored_checksum === checksum && sym.stored_model === MODEL) {
    skipped += 1;
  } else {
    const text = `${sym.name} [${sym.kind}]\n${sym.content ?? ""}`.slice(0, INPUT_LIMIT);
    let vector = null;
    let lastError = null;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      try {
        vector = await provider.embed(text);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < RETRIES) {
          if (process.stdout.isTTY) process.stdout.write("\n");
          console.error(`retry ${sym.path}#${sym.name} (attempt ${attempt + 1}): ${error.message}`);
        }
      }
    }
    if (vector) {
      store.upsert({ symbolId: sym.symbol_id, vector, model: MODEL, checksum });
      done += 1;
    } else {
      failed += 1;
      if (process.stdout.isTTY) process.stdout.write("\n");
      console.error(`skip ${sym.path}#${sym.name}: ${lastError?.message ?? "unknown error"}`);
    }
  }
  const processed = done + skipped + failed;
  currentLabel = `${sym.path}#${sym.name}`;
  renderBar(processed);
}

console.log(`Done: ${done}/${queue.length} embedded, ${skipped} skipped (fresh), ${failed} failed.`);
raw.close();

function checksumText(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;
  return `djb2:${hash.toString(16)}`;
}
