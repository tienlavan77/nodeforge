import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { createProjectIgnoreMatcher } from "../../infrastructure/filesystem/watcher.js";
import { openIndexDatabase } from "../../infrastructure/sqlite/index-database.js";
import { createIncrementalIndexer } from "./incremental-indexer.js";
import { extractorRegistry } from "./parser/index.js";

export async function rebuildIndex({ projectRoot, database, ignore = [], registry = extractorRegistry, indexer } = {}) {
  const ownsDatabase = !database;
  const indexDatabase = database ?? await openIndexDatabase(projectRoot);
  const incrementalIndexer = indexer ?? createIncrementalIndexer({ database: indexDatabase, projectRoot, registry });

  try {
    clearIndex(indexDatabase);
    const isIgnored = createProjectIgnoreMatcher(projectRoot, ignore);
    const indexedPaths = [];
    let indexedFiles = 0;
    for await (const path of scanProject(projectRoot, isIgnored)) {
      if (!registry.supports(path)) continue;
      if (await incrementalIndexer.handle({ type: "watcher.file_created", payload: { path } })) {
        indexedPaths.push(path);
        indexedFiles += 1;
      }
    }
    // A second pass resolves imports whose target appeared later in the directory traversal.
    for (const path of indexedPaths) {
      await incrementalIndexer.handle({ type: "watcher.file_modified", payload: { path } });
    }
    return { indexedFiles };
  } finally {
    if (ownsDatabase) await indexDatabase.close();
  }
}

export function clearIndex(database) {
  for (const table of ["calls", "references", "tests_map", "imports_exports", "dependency_edges", "symbols", "files"]) {
    database.run(`DELETE FROM "${table}"`);
  }
}

async function* scanProject(projectRoot, isIgnored, directory = projectRoot) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (isIgnored(absolutePath)) continue;
    if (entry.isDirectory()) {
      yield* scanProject(projectRoot, isIgnored, absolutePath);
    } else if (entry.isFile()) {
      yield relative(projectRoot, absolutePath).split("\\").join("/");
    }
  }
}
