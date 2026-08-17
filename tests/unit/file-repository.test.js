import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createFileRepository } from "../../src/modules/index/file-repository.js";

test("keeps a generated file_id when a file path is renamed", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-file-repository-"));
  const database = await openIndexDatabase(projectRoot);

  try {
    const repository = createFileRepository(database, { now: () => "2026-08-16T12:00:00Z" });
    const fileId = repository.insert("src/auth.js", { language: "javascript" });

    assert.match(fileId, /^FILE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.doesNotMatch(fileId, /auth|src/);
    assert.equal(repository.findById(fileId).path, "src/auth.js");

    assert.equal(repository.rename(fileId, "src/security/auth.js"), true);
    assert.equal(repository.findById(fileId).file_id, fileId);
    assert.equal(repository.findById(fileId).path, "src/security/auth.js");
  } finally {
    await database.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
