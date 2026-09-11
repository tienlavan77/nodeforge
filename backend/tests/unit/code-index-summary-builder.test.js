import test from "node:test";
import assert from "node:assert/strict";
import { createCodeIndexSummaryBuilder } from "../../src/modules/index/code-index-summary-builder.js";

function builder(content, indexed = {}) {
  const rows = { files: [{ file_id: "f1", language: "javascript", size_bytes: content.length, sha256: "a".repeat(64), ...indexed }], symbols: [{ name: "Header", kind: "function" }], relations: [{ name: "React", kind: "import" }, { name: "Header", kind: "export" }], dependencies: [{ path: "frontend/src/app/layout.js", kind: "import" }] };
  return createCodeIndexSummaryBuilder({ fileService: { readFile: async () => content }, indexDb: { all: (query) => query.includes("FROM files") ? rows.files : query.includes("FROM symbols") ? rows.symbols : query.includes("imports_exports") ? rows.relations : rows.dependencies } });
}

test("builds structural summary from indexed JavaScript", async () => {
  const result = (await builder("export function Header(){ return <button />; } const x = '--theme';").build(["frontend/src/components/Header.jsx"]))[0];
  assert.deepEqual(result.content.functions, ["Header"]);
  assert.deepEqual(result.content.exports, ["Header"]);
  assert.deepEqual(result.content.jsx_elements, ["button"]);
  assert.deepEqual(result.content.css_variables, ["--theme"]);
  assert.equal(result.content.role, "Reusable component");
});

test("returns complete source when summary is disabled", async () => {
  const source = "export default 1;";
  const result = (await builder(source).build(["src/a.js"], { summary: false }))[0];
  assert.equal(result.content, source);
});

test("unReadable paths become placeholders instead of aborting the round", async () => {
  const real = createCodeIndexSummaryBuilder({
    fileService: {
      readFile: async ({ path }) => {
        if (path === "backend/src") { const error = new Error("EISDIR: illegal operation on a directory, read"); error.code = "EISDIR"; throw error; }
        if (path === "backend/missing/thing.js") { const error = new Error("ENOENT: no such file or directory"); error.code = "ENOENT"; throw error; }
        return "export const ok = 1;";
      }
    },
    indexDb: { all: () => [] }
  });
  const result = await real.build(["backend/src", "backend/missing/thing.js", "src/ok.js"], { summary: true });
  assert.equal(result.length, 3);
  const directory = result.find((file) => file.path === "backend/src");
  assert.deepEqual([directory.exists, directory.before_checksum, directory.size_bytes, directory.content], [false, null, 0, null]);
  const missing = result.find((file) => file.path === "backend/missing/thing.js");
  assert.equal(missing.exists, false);
  const valid = result.find((file) => file.path === "src/ok.js");
  assert.equal(valid.exists, true);
  assert.ok(Array.isArray(valid.content.exports));
});
