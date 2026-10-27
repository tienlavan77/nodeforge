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

// Bounds durable snapshot work during large scans while preserving exact in-memory counters.
// A controlled monotonic clock verifies the publication interval without timing-dependent sleeps.
test("routine progress bursts publish at most once per 250 ms and flush on completion", () => {
  let timestamp = 0;
  const snapshots = [];
  const progress = createIndexProgress({ now: () => timestamp, onProgress: (value) => snapshots.push(value) });
  progress.stage("scan/index");
  for (let i = 0; i < 1000; i += 1) {
    progress.discover("eligible");
    progress.result({ path: `file-${i}.js`, status: "unchanged" });
  }
  assert.equal(snapshots.length, 1);
  assert.equal(progress.snapshot().counters.unchanged, 1000);
  timestamp = 249;
  progress.discover("unsupported");
  assert.equal(snapshots.length, 1);
  timestamp = 250;
  progress.discover("ignored");
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].counters.discovered, 1002);
  progress.result({ path: "empty.js", version: 1, status: "indexed", committed: true });
  assert.equal(snapshots.length, 2);
  const final = progress.finish();
  assert.equal(snapshots.length, 3);
  assert.deepEqual(snapshots.at(-1), final);
  assert.equal(final.counters.indexed, 1);
  assert.equal(final.counters.unchanged, 1000);
  assert.equal(final.status, "succeeded");
  assert.ok(snapshots.every((value, i) => i === 0 || value.revision > snapshots[i - 1].revision));
});

// Preserves diagnostic changes, stage boundaries and reconciled inventory inside a throttled
// burst so settlement never depends on a delayed timer to persist required operation evidence.
test("mandatory progress snapshots bypass routine throttling", () => {
  const snapshots = [];
  const progress = createIndexProgress({ now: () => 0, onProgress: (value) => snapshots.push(value) });
  progress.stage("scan/index");
  progress.discover("eligible");
  progress.result({ path: "a.js", status: "failed", marker: "parse_failed", message: "Invalid syntax" });
  assert.equal(snapshots.at(-1).failures[0].resolved, false);
  progress.result({ path: "a.js", status: "indexed", committed: true, version: 1 });
  assert.equal(snapshots.at(-1).failures[0].resolved, true);
  progress.stage("resolve");
  assert.equal(snapshots.at(-1).stage, "resolve");
  progress.reconcile({ all: (sql) => sql.includes("index_metadata") ? [{ version: 1 }] : [] });
  assert.deepEqual(snapshots.at(-1).checkpoint, { version: 1, files: 0, functions: 0 });
  progress.embedding({ status: "failed", failed: 1 });
  assert.equal(snapshots.at(-1).embedding.failed, 1);
  progress.stage("startup/readiness");
  progress.fail(new Error("Startup failed"));
  assert.equal(snapshots.at(-1).status, "failed");
  progress.finish();
  assert.equal(snapshots.at(-1).status, "failed");
  assert.equal(snapshots.length, 9);
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
