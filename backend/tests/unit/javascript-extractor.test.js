import assert from "node:assert/strict";
import test from "node:test";

import { extractorRegistry } from "../../src/modules/index/parser/index.js";

test("extracts JavaScript symbols with their line ranges", () => {
  const source = `function first() {
  return 1;
}

function second() {
  return 2;
}

function third() {
  return 3;
}`;

  const extraction = extractorRegistry.extract("src/example.js", source);

  assert.deepEqual(extraction.symbols, [
    { name: "first", kind: "function", start_line: 1, end_line: 3 },
    { name: "second", kind: "function", start_line: 5, end_line: 7 },
    { name: "third", kind: "function", start_line: 9, end_line: 11 }
  ]);
  assert.deepEqual(extraction.imports, []);
  assert.deepEqual(extraction.exports, []);
});

test("normalizes JavaScript imports and exports", () => {
  const source = `import React from "react";
import main, { helper as localHelper } from "./helpers.js";
export { localHelper };
export default function build() {}`;

  const extraction = extractorRegistry.extract("src/example.ts", source);

  assert.deepEqual(extraction.imports, [
    { source: "react", imported: "default", local: "React", kind: "default", external: true },
    { source: "./helpers.js", imported: "default", local: "main", kind: "default", external: false },
    { source: "./helpers.js", imported: "helper", local: "localHelper", kind: "named", external: false }
  ]);
  assert.deepEqual(extraction.exports, [
    { name: "localHelper", kind: "named", source: null },
    { name: "build", kind: "default", source: null }
  ]);
});

test("extracts direct JavaScript calls with their caller symbol", () => {
  const extraction = extractorRegistry.extract("src/example.js", `function second() {}
function first() {
  second();
}`);

  assert.deepEqual(extraction.calls, [
    { callee_name: "second", line: 3, caller_symbol: "first" }
  ]);
});

// Business purpose: verifies that unsupported file extensions return an empty extraction while .mjs and .cjs modules extract symbols properly.
// Technical description: checks extractorRegistry.supports and extractorRegistry.extract for .py, extensionless paths, .mjs, and .cjs files.
function verifyUnsupportedAndModuleExtensions() {
  assert.deepEqual(extractorRegistry.extract("src/example.py", "def run(): pass"), {
    symbols: [],
    imports: [],
    exports: [],
    calls: []
  });
  assert.equal(extractorRegistry.supports("README"), false);
  assert.equal(extractorRegistry.supports("scripts/example.mjs"), true);
  assert.equal(extractorRegistry.supports("scripts/example.cjs"), true);
  assert.deepEqual(extractorRegistry.extract("scripts/example.mjs", "export function runWorker() { return true; }").symbols, [
    { name: "runWorker", kind: "function", start_line: 1, end_line: 1 }
  ]);
}

test("returns an empty normalized extraction for an unsupported extension", verifyUnsupportedAndModuleExtensions);

// Business purpose: verifies that Reviewer scopedGraph retains graph edges for snapshot and project files and createDependencyGraph resolves snapshot-relative imports.
// Technical description: exercises scopedGraph with role=reviewer and createDependencyGraph.resolve with a .forge/runtime/tickets/ticket-verification snapshot path.
async function verifyReviewerSnapshotGraphAndResolution() {
  const { scopedGraph } = await import("../../src/tools/discovery/agent-file-index-view.js");
  const { createDependencyGraph } = await import("../../src/modules/index/dependency-graph.js");
  const snapshotFile = ".forge/runtime/tickets/ticket-verification/PLAN-TEST/snapshot/0123456789abcdef0123456789abcdef01234567/backend/scripts/control-api-project-runtime.mjs";
  const targetFile = "backend/src/modules/index/embedding-worker.js";
  const graph = {
    imports: [{ path: targetFile, name: "createEmbeddingWorker", kind: "named", broken: false }],
    imported_by: [{ path: "backend/scripts/start-control-api.mjs", name: "startControlApiWorkers", kind: "named", broken: false }],
    calls: [{ caller: { path: snapshotFile, name: "startControlApiWorkers" }, target: { path: targetFile, name: "createEmbeddingWorker" }, line: 45 }]
  };
  const filtered = scopedGraph(graph, { agent_identity: { role: "reviewer" } });
  assert.equal(filtered.imports.length, 1);
  assert.equal(filtered.imported_by.length, 1);
  assert.equal(filtered.calls.length, 1);

  const depGraph = createDependencyGraph({
    database: { run() {} },
    files: { findByPath: (path) => (path === targetFile ? { file_id: "FILE-EMBED-WORKER" } : null) },
    projectRoot: "/repo"
  });
  assert.equal(depGraph.resolve(snapshotFile, "../src/modules/index/embedding-worker.js", false), "FILE-EMBED-WORKER");
}

test("preserves Reviewer code_graph links and resolves snapshot relative imports", verifyReviewerSnapshotGraphAndResolution);

test("extracts JSX UI metadata symbols for .jsx files but not plain .js", () => {
  const source = `export function Panel({ open }) {
  return (
    <div className="architecture-manager-selector" aria-label="Select Architecture Manager">
      <select className={cls} id="manager-select" role="listbox">
        <option className="is-selected">x</option>
      </select>
      <button data-testid="submit-btn" className={\`btn \${open ? "on" : ""}\`}>go</button>
    </div>
  );
}`;

  const jsxExtraction = extractorRegistry.extract("ui/panel.jsx", source);
  assert.deepEqual(jsxExtraction.symbols.filter((symbol) => symbol.kind.startsWith("jsx_")), [
    { name: "architecture-manager-selector", kind: "jsx_class", start_line: 3, end_line: 3 },
    { name: "Select Architecture Manager", kind: "jsx_aria", start_line: 3, end_line: 3 },
    { name: "manager-select", kind: "jsx_id", start_line: 4, end_line: 4 },
    { name: "listbox", kind: "jsx_role", start_line: 4, end_line: 4 },
    { name: "is-selected", kind: "jsx_class", start_line: 5, end_line: 5 },
    { name: "submit-btn", kind: "jsx_data", start_line: 7, end_line: 7 }
  ]);
  assert.ok(jsxExtraction.symbols.some((symbol) => symbol.name === "Panel" && symbol.kind === "function"));

  const jsExtraction = extractorRegistry.extract("ui/panel.js", source);
  assert.equal(jsExtraction.symbols.some((symbol) => symbol.kind.startsWith("jsx_")), false);
});
