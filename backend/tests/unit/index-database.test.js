import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureRuntimeDir, openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";

const TABLES = ["calls", "dependency_edges", "files", "imports_exports", "index_metadata", "references", "symbols", "tests_map"];

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
    assert.deepEqual(firstOpen.all("SELECT version FROM schema_migrations ORDER BY version"), [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    const databasePath = firstOpen.databasePath;
    await firstOpen.close();
    assert.equal((await readFile(databasePath)).subarray(0, 16).toString(), "SQLite format 3\u0000");

    const secondOpen = await openIndexDatabase(projectRoot);
    assert.deepEqual(tableNames(secondOpen), TABLES);
    assert.deepEqual(secondOpen.all("SELECT version FROM schema_migrations ORDER BY version"), [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
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
