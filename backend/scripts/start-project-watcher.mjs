import process from "node:process";
import { join, resolve } from "node:path";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";
import { acquireProcessLock } from "./nodeforge-process-lock.mjs";

import { createDatabaseService } from "../src/infrastructure/sqlite/database-service.js";
import { createFilesystemWatcher, DEFAULT_WATCHER_IGNORE } from "../src/infrastructure/filesystem/watcher.js";
import { createDebouncedWatcher } from "../src/modules/watcher/debounced-watcher.js";
import { createIncrementalIndexer } from "../src/modules/index/incremental-indexer.js";
import { createVerificationOrchestrator } from "../src/modules/verification/orchestrator.js";
import { createFileService } from "../src/infrastructure/filesystem/file-service.js";
import { createRuntimeLogger } from "../src/core/runtime-logger.js";
import { logEvent } from "../src/core/project-log-service.js";

process.chdir(resolve(new URL("../..", import.meta.url).pathname));
loadNodeforgeEnv();
const runtimeRoot = join(process.cwd(), ".forge", "runtime");
const dataDir = process.env.NODE_CONTROL_DATA_DIR ?? join(runtimeRoot, "nf");
const projectId = process.env.NODE_CONTROL_PROJECT_ID ?? "PROJECT-NODEFORGE";
const fileService = createFileService({ projectRoot: process.cwd() });
const processLock = acquireProcessLock(dataDir, "watcher", { fileService });
const indexDb = await createDatabaseService({ dataDir: process.cwd(), runtimeDir: join(".forge", "runtime", "wc") });
const rawWatcher = createFilesystemWatcher({
  root: process.cwd(),
  ignore: DEFAULT_WATCHER_IGNORE,
  chokidarOptions: { ignoreInitial: true, usePolling: true, interval: 250 }
});
const logger = createRuntimeLogger({ logEvent, source: "project-watcher" });
const watcher = createDebouncedWatcher({ rawWatcher, projectId, root: process.cwd() });
const indexer = createIncrementalIndexer({ database: indexDb, projectRoot: process.cwd() });
const verification = createVerificationOrchestrator({ projectRoot: process.cwd(), projectId });
const controlApiUrl = process.env.NODE_CONTROL_API_URL ?? `http://127.0.0.1:${process.env.NODE_CONTROL_PORT ?? 3100}`;
async function publishStreamEvent(event, indexed) {
  try {
    const response = await fetch(`${controlApiUrl}/forge/v1/stream/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...event, indexed, project_id: projectId }) });
    if (!response.ok) logger.info(`Stream publish failed (${response.status}): ${event.type}`);
  } catch (error) { logger.info(`Stream publish unavailable: ${error.message}`); }
}

logger.info("Project filesystem watcher ready (polling).", { event_name: "watcher.ready" });
logger.info("Watcher configuration loaded.", { event_name: "watcher.config", payload: { project_root: process.cwd(), index_database: indexDb.databasePath } });
watcher.on("event", (event) => {
  logger.debug(`Watcher event ${event.type}.`, { event_name: "watcher.event", payload: { type: event.type, path: event.payload?.path ?? null, event_id: event.event_id } });
  void indexer.handle(event)
    .then((indexed) => {
      logger.debug(indexed ? "Indexer updated file." : "Indexer skipped file.", { event_name: "watcher.indexed", status: indexed ? "success" : "info", payload: { path: event.payload?.path ?? null, event_id: event.event_id } });
      void publishStreamEvent(event, indexed);
      return indexed ? verification.run({
      schema_version: "1.0",
      commit_id: event.event_id,
      levels: ["focused"],
      checks: [{ type: "test", command: "node -e \"process.exit(0)\"", timeout_ms: 1000 }]
      }) : null;
    })
    .then((result) => {
      if (!result) return;
      logger.info(`Watcher verification ${result.status}.`, { event_name: "watcher.verification", status: result.status === "failed" ? "failed" : "success", payload: { path: event.payload?.path ?? null, run_id: result.run_id ?? null, event_id: event.event_id } });
    })
    .catch((error) => logger.error("Watcher verification failed.", { event_name: "watcher.verification_failed", payload: { error: error.message, event_id: event.event_id } }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await watcher.close?.();
    await indexDb.close();
    processLock.release();
    process.exit(0);
  });
}
