import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureRuntimeDir, openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";

const TABLES = ["agent_profile_tombstones", "agent_profiles", "calls", "conversations", "dependency_edges", "embedding_jobs", "file_content_fts", "file_content_fts_config", "file_content_fts_content", "file_content_fts_data", "file_content_fts_docsize", "file_content_fts_idx", "files", "imports_exports", "index_metadata", "references", "sqlite_sequence", "symbol_content_fts", "symbol_content_fts_config", "symbol_content_fts_content", "symbol_content_fts_data", "symbol_content_fts_docsize", "symbol_content_fts_idx", "symbol_embeddings", "symbols", "tests_map", "tickets"];
const MIGRATION_VERSIONS = Array.from({ length: 10 }, (_, index) => ({ version: index + 1 }));

test("creates the runtime directory and migrates index.db exactly once", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-index-"));

  try {
    const runtimeDir = await ensureRuntimeDir(projectRoot);
    assert.equal((await stat(runtimeDir)).isDirectory(), true);

    const firstOpen = await openIndexDatabase(projectRoot);
    assert.deepEqual(tableNames(firstOpen), TABLES);
    assert.deepEqual(firstOpen.all("SELECT name, pk FROM pragma_table_info('files') WHERE name IN ('file_id', 'path') ORDER BY name"), [
      { name: "file_id", pk: 1 },
      { name: "path", pk: 0 }
    ]);
    assert.deepEqual(firstOpen.all("SELECT version FROM schema_migrations ORDER BY version"), MIGRATION_VERSIONS);
    const databasePath = firstOpen.databasePath;
    await firstOpen.close();
    assert.equal((await readFile(databasePath)).subarray(0, 16).toString(), "SQLite format 3\u0000");

    const secondOpen = await openIndexDatabase(projectRoot);
    assert.deepEqual(tableNames(secondOpen), TABLES);
    assert.deepEqual(secondOpen.all("SELECT version FROM schema_migrations ORDER BY version"), MIGRATION_VERSIONS);
    await secondOpen.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function tableNames(database) {
  return database
    .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'schema_migrations' ORDER BY name")
    .map(({ name }) => name);
}
