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
const dataDir = process.env.NODE_CONTROL_DATA_DIR ?? join(process.cwd(), ".node-control");
const projectId = process.env.NODE_CONTROL_PROJECT_ID ?? "PROJECT-NODEFORGE";
const processLock = acquireProcessLock(dataDir, "watcher");
const database = await createDatabaseService({ dataDir });
const eventStore = createPersistentEventStore({ database });
const subscriptions = createSubscriptionRegistry();
const publisher = createEventPublisher({ store: eventStore, subscriptions });
const rawWatcher = createFilesystemWatcher({
  root: process.cwd(),
  ignore: DEFAULT_WATCHER_IGNORE,
  chokidarOptions: { ignoreInitial: true, usePolling: true, interval: 250 }
});
const watcher = createDebouncedWatcher({ rawWatcher, projectId, root: process.cwd() });
const indexer = createIncrementalIndexer({ database, projectRoot: process.cwd() });
const verification = createVerificationOrchestrator({ projectRoot: process.cwd(), projectId });

rawWatcher.once("ready", () => process.stdout.write("Project filesystem watcher ready (polling)\n"));
watcher.on("event", (event) => {
  void indexer.handle(event)
    .then((indexed) => indexed ? verification.run({
      schema_version: "1.0",
      commit_id: event.event_id,
      levels: ["focused"],
      checks: [{ type: "test", command: "node -e \"process.exit(0)\"", timeout_ms: 1000 }]
    }) : null)
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
    await database.close();
    processLock.release();
    process.exit(0);
  });
}
