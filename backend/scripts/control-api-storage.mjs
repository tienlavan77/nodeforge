import { join } from "node:path";
import { acquireProcessLock } from "./nodeforge-process-lock.mjs";
import { createDatabaseService } from "../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../src/infrastructure/filesystem/file-service.js";
import { createProtocolStorage } from "../src/infrastructure/storage/protocol-storage.js";
import { createConversationStateStore } from "../src/modules/protocol/conversation-state-store.js";
import { configureProjectLogFileService } from "../src/core/project-log-service.js";
import { createApplicationDisposal } from "./control-api-application-disposal.mjs";

export async function createControlApiStorage({ config, onWrite, configureLogs = true } = {}) {
  const fileService = createFileService({ projectRoot: config.cwd, databaseService: undefined, onWrite });
  const protocolStorage = createProtocolStorage({ fileService, root: config.protocolStorageRoot });
  const conversationStateStore = createConversationStateStore({ fileService });
  if (configureLogs) configureProjectLogFileService(fileService);
  const disposal = createApplicationDisposal();
  try {
    const processLock = disposal.own(acquireProcessLock(config.dataDir, "control", { fileService, projectRoot: config.cwd }), "release", 60);
    const controlDb = disposal.own(await createDatabaseService({ dataDir: config.dataDir, runtimeDir: "." }), "close", 50);
    const indexDb = disposal.own(await createDatabaseService({ dataDir: config.cwd, runtimeDir: join(".forge", "runtime", "wc") }), "close", 40);
    return { fileService, protocolStorage, conversationStateStore, processLock, controlDb, indexDb, disposal };
  } catch (error) {
    try { await disposal.close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Project storage startup and rollback failed.");
    }
    throw error;
  }
}
