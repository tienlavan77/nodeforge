import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createCodeSearch } from "../../src/modules/index/code-search.js";
import { createContextPlanner } from "../../src/modules/index/context-planner.js";
import { createDependencyGraph } from "../../src/modules/index/dependency-graph.js";
import { createFileGraph } from "../../src/modules/index/file-graph.js";
import { createFileRepository } from "../../src/modules/index/file-repository.js";
import { createFunctionGraph } from "../../src/modules/index/function-graph.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { createRelevantTreeSelector } from "../../src/modules/index/relevant-tree.js";

test("runs File Service, incremental index, graph, search, relevant tree, and context planner", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "forge-graph-e2e-"));
  const database = await openIndexDatabase(projectRoot);
  const fileService = createFileService({ projectRoot });
  const files = createFileRepository(database);
  const graph = createDependencyGraph({ database, files, projectRoot });
  const indexer = createIncrementalIndexer({ database, projectRoot, files, graph, fileService, projectLogger: () => {} });
  try {
    await fileService.atomicCreate({ path: "src/events.js", content: "export function publish(message) { return message; }\n" });
    await fileService.atomicCreate({ path: "src/runner.js", content: "import { publish } from './events.js';\nexport function run() { return publish('notification'); }\n" });
    await indexer.handle({ type: "watcher.file_created", payload: { path: "src/events.js" } });
    await indexer.handle({ type: "watcher.file_created", payload: { path: "src/runner.js" } });

    const fileGraph = createFileGraph({ database });
    const functionGraph = createFunctionGraph({ database });
    assert.equal(fileGraph.getImporters("src/events.js").nodes[1].path, "src/runner.js");
    assert.equal(functionGraph.getCallers("src/events.js", "publish").called_by[0].line, 2);

    const search = createCodeSearch({ database });
    assert.ok(search.search({ query: "publish", kind: "content" }).matches.some((match) => match.node.path === "src/events.js"));
    const selector = createRelevantTreeSelector({ search, fileGraph, maxFiles: 10 });
    const tree = selector.select({ title: "Publish notification", objective: "publish notification" });
    assert.ok(tree.tree.some((entry) => entry.path === "src/events.js"));

    const context = await createContextPlanner({ database, fileService, maxFiles: 10 }).plan({ relevantTree: tree.tree });
    assert.ok(context.files.some((entry) => entry.path === "src/events.js"));
    assert.ok(context.files.every((entry) => entry.content.length > 0));
  } finally {
    await database.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
