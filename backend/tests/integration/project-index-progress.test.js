// Verifies truthful attempt progress and parser-specific database inventory. Real scans include
// zero-symbol files, stylesheets and filtered entries; schemas reject fabricated determinate
// percentages while committed inventory is reconciled at an explicit database version.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { indexFixture } from "./project-index-fixture.js";
import { createIndexProgress, FUNCTION_KINDS, INDEX_STAGES } from "../../src/modules/index/index-progress.js";
import { validateIndexProgress } from "../../src/modules/index/index-progress-contract.js";

// Distinguishes scan discovery, eligibility, committed files and function-like inventory.
test("scan counters count empty files and exclude CSS symbols from function totals", async (t) => {
  const f = await indexFixture(t);
  await f.write("a.js", "class Account { save() {} } function load() {}");
  await f.write("empty.js", "");
  await f.write("style.css", ".account { color: red; }");
  await f.write("note.txt", "unsupported");
  await f.write("ignored.js", "function ignored() {}");
  const callbacks = [];
  const snapshots = [];
  const progress = createIndexProgress({ onProgress: (value) => snapshots.push(value) });
  for (const stage of ["preflight", "identity", "membership"]) progress.stage(stage);
  const first = await f.rebuild({ ignore: ["ignored.js"], progress, onFile: (value) => callbacks.push(value) });
  progress.stage("startup/readiness"); progress.finish();
  assert.equal(first.succeeded, true);
  assert.equal(first.indexedFiles, 3);
  assert.deepEqual(first.progress.counters, { discovered: 5, eligible: 3, indexed: 3, unchanged: 0, unsupported: 1, ignored: 1, failed: 0, deleted: 0 });
  assert.equal(first.progress.checkpoint.files, 3);
  assert.equal(first.progress.checkpoint.functions, 2);
  assert.equal(callbacks.filter((value) => value.phase === "index" && value.indexed).length, 3);
  assert.equal(callbacks.filter((value) => value.phase === "resolve").length, 3);
  for (const snapshot of snapshots) {
    assert.deepEqual(snapshot.progress, { mode: "indeterminate", total: null, percent: null, eta: null });
    validateIndexProgress(snapshot);
  }
  assert.deepEqual(Object.keys(progress.snapshot().stages), INDEX_STAGES);
  assert.equal(progress.snapshot().status, "succeeded");
  const second = await f.rebuild({ ignore: ["ignored.js"] });
  assert.equal(second.indexedFiles, 0);
  assert.equal(second.progress.counters.unchanged, 3);
  assert.equal(second.progress.checkpoint.files, 3);
  assert.equal(second.progress.checkpoint.functions, 2);
  assert.equal(second.progress.checkpoint.version, first.progress.checkpoint.version);
});

// Locks parser function vocabulary into the operation snapshot schema and rejects fake progress.
test("progress schema and runtime validation enforce attempt and function definitions", async () => {
  const schema = JSON.parse(await readFile(new URL("../../../schemas/project/project-index-progress.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const progress = createIndexProgress({ attempt: 2 });
  const value = progress.snapshot();
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.deepEqual(value.function_kinds, FUNCTION_KINDS);
  assert.deepEqual(value.function_kinds.css, []);
  assert.equal(validate({ ...value, progress: { mode: "determinate", total: 10, percent: 50, eta: 3 } }), false);
  assert.throws(() => validateIndexProgress(value, 1), /Invalid/);
  assert.throws(() => validateIndexProgress({ ...value, status: "succeeded" }), /Invalid/);
  assert.throws(() => validateIndexProgress({ ...value, function_kinds: { css: ["selector"] } }), /Invalid/);
});

// A failed attempt is never allowed to settle successfully merely because old rows still exist.
test("failed results preserve diagnostics and fail the final progress outcome", () => {
  const progress = createIndexProgress();
  progress.stage("scan/index");
  progress.result({ path: "a.js", status: "failed", committed: false, marker: "parse_failed", message: "Unexpected token" });
  const snapshot = progress.finish();
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.counters.indexed, 0);
  assert.equal(snapshot.failures[0].marker, "parse_failed");
});
