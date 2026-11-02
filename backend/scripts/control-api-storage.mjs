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
    controlDb.transaction(() => {
      const hasIdeas = controlDb.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ideas'").length > 0;
      const hasNotebooks = controlDb.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notebooks'").length > 0;
      if (hasIdeas && !hasNotebooks) {
        const ideasHasPosition = controlDb.all("PRAGMA table_info(ideas)").some((col) => col.name === "position");
        if (!ideasHasPosition) {
          controlDb.run("ALTER TABLE ideas ADD COLUMN position INTEGER NOT NULL DEFAULT 0 CHECK (typeof(position) = 'integer' AND position >= 0)");
        }
        controlDb.run("ALTER TABLE ideas RENAME TO notebooks");
        controlDb.run("DROP INDEX IF EXISTS ideas_by_project_status");
        controlDb.run("DROP INDEX IF EXISTS ideas_by_project_position");
        controlDb.run("DROP INDEX IF EXISTS idx_ideas_project_updated");
        controlDb.run("DROP INDEX IF EXISTS idx_ideas_project_position");
      } else {
        controlDb.run(`CREATE TABLE IF NOT EXISTS notebooks (
          id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
          position INTEGER NOT NULL DEFAULT 0 CHECK (typeof(position) = 'integer' AND position >= 0),
          PRIMARY KEY (project_id, id)
        )`);
        const hasPosition = controlDb.all("PRAGMA table_info(notebooks)").some((col) => col.name === "position");
        if (!hasPosition) {
          controlDb.run("ALTER TABLE notebooks ADD COLUMN position INTEGER NOT NULL DEFAULT 0 CHECK (typeof(position) = 'integer' AND position >= 0)");
        }
        if (hasIdeas) {
          const ideasHasPosition = controlDb.all("PRAGMA table_info(ideas)").some((col) => col.name === "position");
          controlDb.run(`INSERT OR IGNORE INTO notebooks (id, project_id, content, status, created_at, updated_at, version, position)
            SELECT id, project_id, content, status, created_at, updated_at, version, ${ideasHasPosition ? "position" : "0"} FROM ideas`);
          controlDb.run("DROP INDEX IF EXISTS ideas_by_project_status");
          controlDb.run("DROP INDEX IF EXISTS ideas_by_project_position");
          controlDb.run("DROP INDEX IF EXISTS idx_ideas_project_updated");
          controlDb.run("DROP INDEX IF EXISTS idx_ideas_project_position");
          controlDb.run("DROP TABLE ideas");
        }
      }
      controlDb.run("CREATE INDEX IF NOT EXISTS idx_notebooks_project_updated ON notebooks (project_id, status, created_at, id)");
      controlDb.run("CREATE INDEX IF NOT EXISTS idx_notebooks_project_position ON notebooks (project_id, position, created_at, id)");
      const hasIdeaDeletions = controlDb.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'idea_deletions'").length > 0;
      const hasNotebookDeletions = controlDb.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notebook_deletions'").length > 0;
      if (hasIdeaDeletions && !hasNotebookDeletions) {
        controlDb.run("ALTER TABLE idea_deletions RENAME TO notebook_deletions");
        controlDb.run("DROP INDEX IF EXISTS idx_idea_deletions_project_deleted");
      } else {
        controlDb.run(`CREATE TABLE IF NOT EXISTS notebook_deletions (
          project_id TEXT NOT NULL,
          id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
          PRIMARY KEY (project_id, id)
        )`);
        if (hasIdeaDeletions) {
          controlDb.run(`INSERT OR IGNORE INTO notebook_deletions (project_id, id, version)
            SELECT project_id, id, version FROM idea_deletions`);
          controlDb.run("DROP INDEX IF EXISTS idx_idea_deletions_project_deleted");
          controlDb.run("DROP TABLE idea_deletions");
        }
      }
      controlDb.run("CREATE INDEX IF NOT EXISTS idx_notebook_deletions_project_deleted ON notebook_deletions (project_id, id)");
    });
    const indexDb = disposal.own(await createDatabaseService({ dataDir: config.cwd, runtimeDir: join(".forge", "runtime", "wc") }), "close", 40);
    return { fileService, protocolStorage, conversationStateStore, processLock, controlDb, indexDb, disposal };
  } catch (error) {
    try { await disposal.close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Project storage startup and rollback failed.");
    }
    throw error;
  }
}
