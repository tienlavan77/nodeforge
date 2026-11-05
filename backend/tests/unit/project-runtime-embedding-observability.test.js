// Purpose: Verifies Embedding Worker observability, PHP/JS watcher comment normalization, and foreground progress bar tracking for external projects.
// Business purpose: Ensures that when an agent edits PHP or JavaScript code in an external project (such as the document plugin), the Watcher and Embedding Worker normalize missing comments, vectorize symbol summaries immediately, emit terminal/log events with the project ID, ignore atomicWrite temp files, and update the foreground status bar.
// Technical description: Tests extractFunctionSignatures on PHP methods, createProjectIgnoreMatcher on .tmp-* files, startProjectRuntime + watcher live file edits on PHP/JS files, and createForegroundView catalog-aware embedding progress rendering.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";
import { createProjectIgnoreMatcher } from "../../src/infrastructure/filesystem/watcher.js";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";
import { extractFunctionSignatures, findFunctionDeclarationLine, hasPrecedingComment } from "../../src/tools/governance/agent-code-conventions.js";
import { createForegroundView } from "../../scripts/dev-foreground-view.mjs";

// Purpose: Polls a condition until it becomes truthy or times out.
// Business purpose: Keeps asynchronous watcher and embedding worker assertions deterministic.
// Technical description: Evaluates predicate every 20ms up to timeoutMs and throws on timeout.
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}

test("extractFunctionSignatures and hasPrecedingComment recognize PHP visibility and static method modifiers", () => {
  const phpSource = [
    "<?php",
    "// Provides document controller actions.",
    "class DocumentController {",
    "  // Returns the document list for the current user.",
    "  public function listDocuments() {}",
    "  protected static function buildQuery() {}",
    "}"
  ].join("\n");

  const signatures = extractFunctionSignatures(phpSource);
  assert.equal(signatures.has("listDocuments"), true);
  assert.equal(signatures.has("buildQuery"), true);
  assert.equal(findFunctionDeclarationLine(phpSource, "listDocuments"), 4);
  assert.equal(hasPrecedingComment(phpSource, "listDocuments"), true);
  assert.equal(hasPrecedingComment(phpSource, "buildQuery"), false);
});

test("createProjectIgnoreMatcher ignores atomicWrite temporary files (*.tmp-*)", () => {
  const isIgnored = createProjectIgnoreMatcher("/project");
  assert.equal(isIgnored("/project/src/model.js.tmp-2f273c64-d2ea-4153-8bfb-da7d5fee7d87"), true);
  assert.equal(isIgnored("/project/core/Controller.php.tmp-12345"), true);
  assert.equal(isIgnored("/project/src/model.js"), false);
});

test("startProjectRuntime normalizes edited PHP/JS files on watcher events, vectorizes summaries, and emits terminal embedding logs", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "nf-doc-embed-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const docRoot = join(workspace, "document");
  await mkdir(join(docRoot, "core"), { recursive: true });
  await writeFile(
    join(docRoot, "core", "DocumentApi.php"),
    "<?php\n// Document API module.\nclass DocumentApi {\n  // Initial endpoint.\n  public function initEndpoint() { return true; }\n}\n",
    "utf8"
  );

  const rawWatcher = new EventEmitter();
  rawWatcher.close = async () => {};

  const persistedLogs = [];
  const terminalLines = [];
  const runtimeLogger = createRuntimeLogger({
    logEvent: (entry) => persistedLogs.push(entry),
    output: { write: (chunk) => terminalLines.push(String(chunk)) },
    source: "project-watcher"
  });

  const embeddedTexts = [];
  const projectId = "PROJECT-DOC-TEST";
  const runtime = await startProjectRuntime({
    projectRoot: docRoot,
    projectId,
    logger: runtimeLogger,
    watcherFactory: () => {
      setImmediate(() => rawWatcher.emit("ready"));
      return rawWatcher;
    },
    ollamaConfig: { model: "doc-embed-model" },
    embeddingProvider: {
      model: "doc-embed-model",
      async embed(text) {
        embeddedTexts.push(text);
        return [0.1, 0.2, 0.3];
      }
    },
    embeddingPollMs: 40
  });
  t.after(() => runtime.close());

  await waitFor(() => persistedLogs.some((e) => e.event_name === "embedding_worker.completed" && e.project_id === projectId));
  assert.equal(embeddedTexts.length, 1);

  // Simulate an agent modifying the PHP file and adding a new method without a comment.
  const phpPath = join(docRoot, "core", "DocumentApi.php");
  await writeFile(
    phpPath,
    "<?php\nclass DocumentApi {\n  public function initEndpoint() { return true; }\n  public function exportInvoicePdf() { return 'pdf'; }\n}\n",
    "utf8"
  );
  rawWatcher.emit("change", phpPath);

  await waitFor(() => {
    const rows = runtime.database.all(
      "SELECT s.name, s.summary, e.content_checksum FROM symbols s JOIN symbol_embeddings e ON e.symbol_id = s.symbol_id WHERE s.name = 'exportInvoicePdf'"
    );
    return rows.length === 1 ? rows[0] : null;
  });

  await waitFor(() => persistedLogs.filter((e) => e.event_name === "embedding_worker.completed" && e.project_id === projectId).length >= 2);
  assert.ok(terminalLines.some((line) => line.includes("Embedding job completed") && line.includes(projectId)));

  // Verify dev-foreground-view reads the external project's SQLite database when catalog and worker logs reference it.
  await mkdir(join(workspace, ".nodeforge", "catalog"), { recursive: true });
  await writeFile(
    join(workspace, ".nodeforge", "catalog", "projects.json"),
    JSON.stringify([{ root: docRoot, projectId }]),
    "utf8"
  );

  const chunks = [];
  const logLines = terminalLines.map((line) => ({ time: "17:20:00", name: "api", line: line.trim() }));
  const { render } = createForegroundView({
    children: new Map(),
    serviceState: new Map([["api", "running"]]),
    logLines,
    suggestions: [],
    isActive: () => true,
    output: { rows: 24, columns: 120, write: (chunk) => chunks.push(String(chunk)) },
    projectRoot: workspace,
    getGitInfo: () => "main"
  });
  render({ input: "", cursor: 0, scrollBack: 0, copyMode: false });
  const screen = chunks.join("");
  assert.ok(screen.includes("embed "), "Expected foreground status bar to render embedding progress for external project");
  assert.ok(screen.includes("2 vectors"), `Expected 2 vectors in status bar, got: ${screen}`);
});
