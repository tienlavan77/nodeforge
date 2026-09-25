import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";

// Builds a watcher-style file event payload for indexer tests.
export function event(type, path, oldPath) {
  return { type, payload: oldPath ? { path, old_path: oldPath } : { path } };
}

// Writes a fixture file under a temporary project root, creating parent directories as needed.
export async function writeProjectFile(projectRoot, path, content) {
  const filePath = join(projectRoot, path);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

// Computes the SHA-256 hex digest of file content, matching the indexer's own hashing.
export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

// Creates a temporary project and a real incremental indexer against a fresh index database, then tears both down.
export async function withIndexer(options, callback) {
  if (typeof options === "function") return withIndexer({}, options);

  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-incremental-indexer-"));
  const database = await openIndexDatabase(projectRoot);
  const indexer = createIncrementalIndexer({ database, projectRoot, ...options });
  try {
    await callback({ projectRoot, database, indexer });
  } finally {
    await database.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
}
