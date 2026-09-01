import assert from "node:assert/strict";
import test from "node:test";
import { createUnwiredFileChecker } from "../../src/modules/workflows/unwired-file-checker.js";

test("returns only newly-created files with no importers", () => {
  const checker = createUnwiredFileChecker({ fileGraph: { getImporters: (path) => path === "src/used.js" ? { nodes: [{ path }, { path: "src/app.js" }] } : { nodes: [{ path }] } } });
  assert.deepEqual(checker.checkUnwiredFiles([
    { path: "src/used.js", action: "created" },
    { path: "src/orphan.js", action: "created" },
    { path: "src/changed.js", action: "modified" }
  ]), [{ path: "src/orphan.js", status: "unwired", imported_by: [] }]);
});

test("propagates graph errors other than a missing index entry", () => {
  const checker = createUnwiredFileChecker({ fileGraph: { getImporters: () => { throw new Error("database unavailable"); } } });
  assert.throws(() => checker.checkUnwiredFiles([{ path: "src/new.js", action: "created" }]), /database unavailable/);
});
