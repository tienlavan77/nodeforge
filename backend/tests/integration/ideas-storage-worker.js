// Runs one notebook mutation in an independent thread and SQLite connection.
// The parent releases all contenders only after their database initialization completes.
import { parentPort, workerData } from "node:worker_threads";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createIdeasStore } from "../../src/modules/projects/ideas-store.js";

const db = await openIndexDatabase(workerData.root, { storageKind: "control" });
const store = createIdeasStore({ controlDb: db, projectId: "a" });
parentPort.once("message", async () => {
  try {
    const result = workerData.operation === "delete"
      ? store.delete(workerData.id, { version: 1 })
      : store.update(workerData.id, { version: 1, content: workerData.content });
    parentPort.postMessage({ status: 200, result });
  } catch (error) {
    parentPort.postMessage({ status: error.status ?? 500, message: error.message });
  } finally { await db.close(); }
});
parentPort.postMessage({ ready: true });
