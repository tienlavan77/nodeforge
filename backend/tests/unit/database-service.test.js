import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";

test("database service exposes serialized transactional writes and parallel reads", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "nodeforge-db-"));
  const service = await createDatabaseService({ dataDir });
  service.write("CREATE TABLE queued (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  service.write("INSERT INTO queued (id, value) VALUES (?, ?)", [1, "one"]);
  service.transaction(() => {
    service.run("INSERT INTO queued (id, value) VALUES (?, ?)", [2, "two"]);
    service.run("INSERT INTO queued (id, value) VALUES (?, ?)", [3, "three"]);
  });
  assert.deepEqual(service.read("SELECT value FROM queued ORDER BY id").map(({ value }) => value), ["one", "two", "three"]);
  await service.close();
});
