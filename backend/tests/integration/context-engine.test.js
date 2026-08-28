import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { ConfigurationError } from "../../src/shared/errors.js";
import { ContextStaleError, createContextEngine, createContextPackValidator } from "../../src/modules/context/context-engine.js";

const sampleProject = fileURLToPath(new URL("../fixtures/sample-project", import.meta.url));

async function setup() {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-context-engine-"));
  await cp(sampleProject, projectRoot, { recursive: true });
  const database = await openIndexDatabase(projectRoot);
  const indexer = createIncrementalIndexer({ database, projectRoot });
  await indexer.handle({ type: "watcher.file_created", payload: { path: "src/utils.js" } });
  await indexer.handle({ type: "watcher.file_created", payload: { path: "src/auth.js" } });
  const engine = createContextEngine({
    database,
    projectRoot,
    projectId: "PROJECT-context-engine",
    clock: () => new Date("2026-08-18T09:00:00Z")
  });
  return { projectRoot, database, engine };
}

async function teardown({ projectRoot, database }) {
  await database?.close();
  await rm(projectRoot, { recursive: true, force: true });
}

test("builds an Ajv-valid minimal symbol context with dependencies", async () => {
  const state = await setup();
  try {
    const pack = await state.engine.build({ task_id: "TASK-context-001", session_id: "SESSION-context-001", purpose: "review", symbol: { name: "login", file: "src/auth.js" } });
    assert.equal(pack.index_version.startsWith("IDX-"), true);
    assert.equal(pack.generated_at, "2026-08-18T09:00:00.000Z");
    assert.deepEqual(pack.symbols.map(({ name }) => name), ["login"]);
    assert.deepEqual(pack.files.map(({ path }) => path), ["src/auth.js", "src/utils.js"]);
    assert.match(pack.files[0].content, /export function login/);
    assert.equal(pack.files[0].content_mode, "excerpt");
    assert.deepEqual(pack.dependencies, [{ symbol: "helper", signature: "function helper", file: "src/utils.js" }]);
    assert.equal(pack.project_summary, "Selected 1 symbol(s), 2 indexed file(s), and 1 dependency signature(s).");
    assert.equal(createContextPackValidator()(pack), true);
  } finally {
    await teardown(state);
  }
});

test("selects dependency and requested line range without duplicate file content", async () => {
  const state = await setup();
  try {
    const pack = await state.engine.build({
      task_id: "TASK-context-002",
      purpose: "debug",
      symbols: ["login", "login"],
    });
    assert.equal(pack.files.filter(({ path }) => path === "src/auth.js").length, 1);
    assert.equal(pack.symbols.length, 1);
    assert.equal(pack.files.find(({ path }) => path === "src/utils.js").content_mode, "signature");

    const rangePack = await state.engine.build({
      task_id: "TASK-context-002",
      purpose: "debug",
      line_ranges: [{ path: "src/auth.js", start_line: 1, end_line: 3 }],
      include_dependencies: false
    });
    const [rangeFile] = rangePack.files;
    assert.equal(rangePack.files.length, 1);
    assert.equal(rangeFile.path, "src/auth.js");
    assert.equal(rangeFile.reason, "requested line range");
    assert.equal(rangeFile.content, 'import { helper } from "./utils.js";\n\nexport function login() {');
    assert.equal(rangeFile.content_mode, "excerpt");
    assert.equal(rangeFile.start_line, 1);
    assert.equal(rangeFile.end_line, 3);
    assert.match(rangeFile.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await teardown(state);
  }
});

test("accepts the current index version and rejects a stale requested version", async () => {
  const state = await setup();
  try {
    const current = await state.engine.build({ task_id: "TASK-context-003", path: "src/auth.js", include_dependencies: false });
    const same = await state.engine.build({ task_id: "TASK-context-003", path: "src/auth.js", index_version: current.index_version, include_dependencies: false });
    assert.equal(same.index_version, current.index_version);
    await assert.rejects(
      () => state.engine.build({ task_id: "TASK-context-003", path: "src/auth.js", index_version: "IDX-stale", include_dependencies: false }),
      (error) => error instanceof ContextStaleError && error.code === "CONTEXT_STALE"
    );
    state.database.run("UPDATE index_metadata SET version = version + 1");
    await assert.rejects(
      () => state.engine.build({ task_id: "TASK-context-003", path: "src/auth.js", index_version: current.index_version, include_dependencies: false }),
      (error) => error instanceof ContextStaleError && error.code === "CONTEXT_STALE"
    );
    const filePath = join(state.projectRoot, "src/auth.js");
    await writeFile(filePath, `${await readFile(filePath, "utf8")}\n// changed without indexing\n`);
    await assert.rejects(
      () => state.engine.build({ task_id: "TASK-context-003", path: "src/auth.js", include_dependencies: false }),
      (error) => error instanceof ContextStaleError && error.code === "CONTEXT_STALE"
    );
  } finally {
    await teardown(state);
  }
});

test("rejects missing symbols, files, and task identity", async () => {
  const state = await setup();
  try {
    await assert.rejects(() => state.engine.build({ task_id: "TASK-context-004", symbol: "missing" }), ConfigurationError);
    await assert.rejects(() => state.engine.build({ task_id: "TASK-context-004", path: "src/missing.js" }), ConfigurationError);
    await assert.rejects(() => state.engine.build({ path: "src/auth.js" }), /requires task_id/);
  } finally {
    await teardown(state);
  }
});

test("enforces the requested context token budget and reports actual usage", async () => {
  const state = await setup();
  try {
    const pack = await state.engine.build({ task_id: "TASK-context-budget", path: "src/auth.js", include_dependencies: false, max_tokens: 5000 });
    assert.equal(pack.budget.actual_token_count, pack.budget.estimated_tokens);
    await assert.rejects(
      () => state.engine.build({ task_id: "TASK-context-budget", path: "src/auth.js", include_dependencies: false, max_tokens: 1 }),
      /Context budget exceeded/
    );
  } finally {
    await teardown(state);
  }
});
