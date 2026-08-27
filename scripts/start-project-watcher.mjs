import process from "node:process";
import { join } from "node:path";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";
import { acquireProcessLock } from "./nodeforge-process-lock.mjs";

import { createDatabaseService } from "../src/infrastructure/sqlite/database-service.js";
import { createPersistentEventStore } from "../src/modules/events/persistent-event-store.js";
import { createSubscriptionRegistry } from "../src/modules/events/subscription-registry.js";
import { createEventPublisher } from "../src/modules/events/event-publisher.js";
import { createFilesystemWatcher, DEFAULT_WATCHER_IGNORE } from "../src/infrastructure/filesystem/watcher.js";
import { createDebouncedWatcher } from "../src/modules/watcher/debounced-watcher.js";
import { createIncrementalIndexer } from "../src/modules/index/incremental-indexer.js";
import { createVerificationOrchestrator } from "../src/modules/verification/orchestrator.js";

loadNodeforgeEnv();
const runtimeRoot = join(process.cwd(), ".forge", "runtime");
const dataDir = process.env.NODE_CONTROL_DATA_DIR ?? join(runtimeRoot, "nf");
const projectId = process.env.NODE_CONTROL_PROJECT_ID ?? "PROJECT-NODEFORGE";
const processLock = acquireProcessLock(dataDir, "watcher");
// Control DB stores events; the project index also uses DatabaseService so all
// watcher/indexer mutations are serialized through the SQLite write queue.
const controlDb = await createDatabaseService({ dataDir, runtimeDir: "." });
const indexDb = await createDatabaseService({ dataDir: process.cwd(), runtimeDir: join(".forge", "runtime", "wc") });
const eventStore = createPersistentEventStore({ database: controlDb });
const subscriptions = createSubscriptionRegistry();
const publisher = createEventPublisher({ store: eventStore, subscriptions });
const rawWatcher = createFilesystemWatcher({
  root: process.cwd(),
  ignore: DEFAULT_WATCHER_IGNORE,
  chokidarOptions: { ignoreInitial: true, usePolling: true, interval: 250 }
});
function timestamp() { return new Date().toISOString().slice(0, 19).replace("T", " "); }
function log(message) { process.stdout.write(`[${timestamp()}] ${message}\n`); }
for (const rawType of ["add", "change", "unlink"]) {
  rawWatcher.on(rawType, (path) => log(`Filesystem ${rawType}: ${path}`));
}
const watcher = createDebouncedWatcher({ rawWatcher, projectId, root: process.cwd() });
const indexer = createIncrementalIndexer({ database: indexDb, projectRoot: process.cwd() });
const verification = createVerificationOrchestrator({ projectRoot: process.cwd(), projectId });

rawWatcher.once("ready", () => log("Project filesystem watcher ready (polling)"));
rawWatcher.once("ready", () => { log(`Project root watched: ${process.cwd()}`); log(`Index database: ${indexDb.databasePath}`); });
watcher.on("event", (event) => {
  log(`Watcher event: ${event.type} ${event.payload?.path ?? ""}`);
  void indexer.handle(event)
    .then((indexed) => {
      log(`Indexer ${indexed ? "updated" : "skipped"}: ${event.payload?.path ?? ""}`);
      return indexed ? verification.run({
      schema_version: "1.0",
      commit_id: event.event_id,
      levels: ["focused"],
      checks: [{ type: "test", command: "node -e \"process.exit(0)\"", timeout_ms: 1000 }]
      }) : null;
    })
    .then((result) => {
      if (!result) return;
      publisher.publish({
        event_id: `VERIFY-EVENT-${event.event_id}`,
        type: "verification.result",
        project_id: projectId,
        timestamp: new Date().toISOString(),
        payload: { watcher_event_id: event.event_id, path: event.payload?.path, result }
      });
    })
    .catch((error) => console.error("Watcher verification failed", { error: error.message, event_id: event.event_id }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await watcher.close?.();
    await indexDb.close();
    await controlDb.close();
    processLock.release();
    process.exit(0);
  });
}
