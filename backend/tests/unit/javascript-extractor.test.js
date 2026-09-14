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

test("returns an empty normalized extraction for an unsupported extension", () => {
  assert.deepEqual(extractorRegistry.extract("src/example.py", "def run(): pass"), {
    symbols: [],
    imports: [],
    exports: [],
    calls: []
  });
  assert.equal(extractorRegistry.supports("README"), false);
});

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
