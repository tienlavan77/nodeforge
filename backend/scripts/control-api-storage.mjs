import { join } from "node:path";
import { acquireProcessLock } from "./nodeforge-process-lock.mjs";
import { createDatabaseService } from "../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../src/infrastructure/filesystem/file-service.js";
import { createProtocolStorage } from "../src/infrastructure/storage/protocol-storage.js";
import { createConversationStateStore } from "../src/modules/protocol/conversation-state-store.js";
import { configureProjectLogFileService } from "../src/core/project-log-service.js";

export async function createControlApiStorage({ config, onWrite } = {}) {
  const fileService = createFileService({ projectRoot: config.cwd, databaseService: undefined, onWrite });
  const protocolStorage = createProtocolStorage({ fileService, root: config.protocolStorageRoot });
  const conversationStateStore = createConversationStateStore({ fileService });
  configureProjectLogFileService(fileService);
  const processLock = acquireProcessLock(config.dataDir, "control", { fileService });
  const controlDb = await createDatabaseService({ dataDir: config.dataDir, runtimeDir: "." });
  const indexDb = await createDatabaseService({ dataDir: config.cwd, runtimeDir: join(".forge", "runtime", "wc") });
  return { fileService, protocolStorage, conversationStateStore, processLock, controlDb, indexDb };
}
