// Runs the real project watcher and incremental indexer in a child process for cache integration tests.
import { writeFile } from "node:fs/promises";
import { createFilesystemWatcher } from "../../src/infrastructure/filesystem/watcher.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { rebuildIndex } from "../../src/modules/index/index-rebuild.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { createDebouncedWatcher } from "../../src/modules/watcher/debounced-watcher.js";

const [root, url, ready] = process.argv.slice(2);
const database = await openIndexDatabase(root);
await rebuildIndex({ projectRoot: root, database });
const indexer = createIncrementalIndexer({ database, projectRoot: root });
const rawWatcher = createFilesystemWatcher({ root, chokidarOptions: { ignoreInitial: true, usePolling: true, interval: 30 } });
const projectId = process.env.CACHE_TEST_PROJECT_ID ?? "P";
const watcher = createDebouncedWatcher({ rawWatcher, projectId, root, debounceMs: 100 });
let closing = false;

// Sends a real indexed file event to the Control API without blocking future watcher events.
async function publish(event) {
  if (closing || !["src/example.js", "src/renamed.js"].includes(event.payload?.path)) return;
  const indexDelayMs = Number(process.env.CACHE_TEST_INDEX_DELAY_MS ?? 0);
  if (process.env.CACHE_TEST_PRE_INDEX_MARKER) await writeFile(process.env.CACHE_TEST_PRE_INDEX_MARKER, event.event_id);
  if (indexDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, indexDelayMs));
  const indexed = await indexer.handle(event);
  if (process.env.CACHE_TEST_INDEX_MARKER) await writeFile(process.env.CACHE_TEST_INDEX_MARKER, indexed ? "indexed" : "skipped");
  const row = database.all("SELECT sha256 FROM files WHERE path = ? LIMIT 1", [event.payload.path])[0];
  if (process.env.CACHE_TEST_EVENT_MARKER) await writeFile(process.env.CACHE_TEST_EVENT_MARKER, event.type);
  const sha256 = process.env.CACHE_TEST_SHA_OVERRIDE && event.type === "watcher.file_modified" ? process.env.CACHE_TEST_SHA_OVERRIDE : row?.sha256;
  const body = { ...event, project_id: projectId, indexed, payload: { ...event.payload, ...(sha256 ? { sha256 } : {}) } };
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000), body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Watcher POST failed: ${response.status}`);
}

watcher.on("event", (event) => { void publish(event).catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }); });
await new Promise((resolve) => rawWatcher.once("ready", resolve));
await writeFile(ready, "ready");
process.once("SIGTERM", () => { void (async () => { closing = true; await watcher.close(); await database.close(); process.exit(); })().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exit(1); }); });
