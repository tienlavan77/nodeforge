// Provides module declarations and business logic for index-rebuild.js.

import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { createProjectIgnoreMatcher } from "../../infrastructure/filesystem/watcher.js";
import { ensureForgeLayout } from "../../infrastructure/filesystem/forge-layout.js";
import { openIndexDatabase } from "../../infrastructure/sqlite/index-database.js";
import { createIncrementalIndexer } from "./incremental-indexer.js";
import { createSummaryConversion } from "./purpose-summary-conversion.js";
import { extractorRegistry } from "./parser/index.js";
import { createIndexProgress } from "./index-progress.js";
import { readContentHash } from "../watcher/debounced-watcher.js";

const CODE_INDEX_RUNTIME_DIR = statePath("wc");

// Defines rebuildIndex function behavior for index-rebuild.js.
export async function rebuildIndex({ projectRoot, database, runtimeDir = CODE_INDEX_RUNTIME_DIR, ignore = [], registry = extractorRegistry, indexer, embeddingJobs = null, embeddingModel = "embeddinggemma", onFile = () => {}, onProgress = () => {}, progress = createIndexProgress({ onProgress }), force = false } = {}) {
  await ensureForgeLayout(projectRoot);
  const ownsDatabase = !database;
  const indexDatabase = database ?? await openIndexDatabase(projectRoot, { runtimeDir });
  const conversion = createSummaryConversion(indexDatabase);
  const incrementalIndexer = indexer ?? createIncrementalIndexer({ database: indexDatabase, projectRoot, registry, embeddingJobs, embeddingModel });
  // Adapts injected legacy indexers while keeping false distinct from a successful commit.
  async function handle(event) {
    if (incrementalIndexer.handleDetailed) return incrementalIndexer.handleDetailed(event);
    try {
      const committed = await incrementalIndexer.handle(event);
      return { path: event.payload.path, status: committed ? event.type === "watcher.file_deleted" ? "deleted" : "indexed" : "unchanged", committed,
        version: indexDatabase.all("SELECT version FROM index_metadata")[0]?.version ?? 0 };
    } catch (error) { return { path: event.payload.path, status: "failed", committed: false, marker: error.code ?? "index_failed", message: error.message }; }
  }
  // Preserves the established callback fields and adds explicit result details for new consumers.
  function report(result, phase) {
    progress.result(result);
    onFile({ path: result.path, indexed: phase === "resolve" && result.status !== "failed" ? true : result.committed, skipped: result.status === "unchanged", phase, result });
  }
  try {
    // Force means retry extraction, never erase committed rows before replacement succeeds.
    const isIgnored = createProjectIgnoreMatcher(projectRoot, ignore);
    const indexedPaths = [];
    const seenPaths = new Set();
    progress.stage("scan/index");
    for await (const entry of scanProject(projectRoot, isIgnored)) {
      const { path, ignored } = entry;
      if (ignored) { progress.discover("ignored"); continue; }
      if (!registry.supports(path)) { progress.discover("unsupported"); continue; }
      progress.discover("eligible");
      seenPaths.add(path);
      const existing = indexDatabase.all("SELECT file_id, sha256 FROM files WHERE path = ?", [path])[0];
      try {
        const currentHash = !force && existing ? await readContentHash(join(projectRoot, path)) : null;
        if (existing && currentHash && existing.sha256 === currentHash && !conversion.needed(existing)) {
          report({ path, status: "unchanged", committed: false }, "index"); continue;
        }
        const result = await handle({ type: existing ? "watcher.file_modified" : "watcher.file_created", payload: { path }, force });
        report(result, "index");
        if (result.committed) indexedPaths.push(path);
      } catch (error) { report({ path, status: "failed", committed: false, marker: error.code ?? "read_failed", message: error.message }, "index"); }
    }
    for (const row of indexDatabase.all("SELECT path FROM files")) {
      if (seenPaths.has(row.path) || isIgnored(join(projectRoot, row.path))) continue;
      report(await handle({ type: "watcher.file_deleted", payload: { path: row.path } }), "delete");
    }
    progress.stage("resolve");
    for (const path of indexedPaths) {
      const result = await handle({ type: "watcher.file_modified", payload: { path }, phase: "resolve" });
      if (result.status !== "failed") result.status = "resolved";
      result.committed = false;
      report(result, "resolve");
    }
    progress.reconcile(indexDatabase);
    const snapshot = progress.snapshot();
    return { indexedFiles: snapshot.counters.indexed, progress: snapshot, succeeded: !snapshot.failures.some((failure) => !failure.resolved) };
  } catch (error) { progress.fail(error); throw error; } finally {
    if (ownsDatabase) await indexDatabase.close();
  }
}

// Defines clearIndex function behavior for index-rebuild.js.
export function clearIndex(database) {
  for (const table of ["calls", "references", "tests_map", "imports_exports", "dependency_edges", "symbol_content_fts", "file_content_fts", "symbol_embeddings", "symbols", "files"]) {
    database.run(`DELETE FROM "${table}"`);
  }
}

// Defines scanProject function behavior for index-rebuild.js.
async function* scanProject(projectRoot, isIgnored, directory = projectRoot) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const path = relative(projectRoot, absolutePath).split("\\").join("/");
    if (isIgnored(absolutePath)) { if (entry.isFile()) yield { path, ignored: true }; continue; }
    if (entry.isDirectory()) yield* scanProject(projectRoot, isIgnored, absolutePath);
    else if (entry.isFile()) yield { path, ignored: false };
  }
}
