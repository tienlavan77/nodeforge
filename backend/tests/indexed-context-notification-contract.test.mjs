// Verifies indexed context never falls back to unindexed or unsafe source content.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileService } from "../src/infrastructure/filesystem/file-service.js";
import { createContextPlanner } from "../src/modules/index/context-planner.js";

// Creates a disposable index and file-service pair for indexed-context checks.
async function fixture(t, { indexed = true, stale = false, unavailable = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-index-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  const content = "export function example() {}\n";
  await writeFile(join(root, "src", "example.js"), content);
  const sha256 = createHash("sha256").update(stale ? "old content" : content).digest("hex");
  let reads = 0;
  const source = createFileService({ projectRoot: root });
  const fileService = { readForIndex(input) { reads += 1; return source.readForIndex(input); } };
  const database = { all(query, params) {
    if (unavailable) throw new Error("index unavailable");
    if (query.includes("FROM files")) return indexed ? [{ file_id: "FILE-1", path: params[0], language: "javascript", sha256, size_bytes: content.length }] : [];
    return [{ version: 1 }];
  } };
  return { planner: createContextPlanner({ fileService, database }), reads: () => reads };
}

test("fresh indexed context returns checksum-verified File Service content", async (t) => {
  const { planner, reads } = await fixture(t);
  const result = await planner.plan({ relevantTree: ["src/example.js"] });
  assert.equal(result.source, "file-service");
  assert.equal(result.files[0].content, "export function example() {}\n");
  assert.equal(reads(), 1);
});

test("missing index rejects before reading source", async (t) => {
  const { planner, reads } = await fixture(t, { indexed: false });
  await assert.rejects(planner.plan({ relevantTree: ["src/example.js"] }), /Indexed file not found/);
  assert.equal(reads(), 0);
});

test("stale index rejects mismatched source checksum", async (t) => {
  const { planner } = await fixture(t, { stale: true });
  await assert.rejects(planner.plan({ relevantTree: ["src/example.js"] }), (error) => error.code === "CONTEXT_STALE");
});

test("unavailable index never reads source as fallback", async (t) => {
  const { planner, reads } = await fixture(t, { unavailable: true });
  await assert.rejects(planner.plan({ relevantTree: ["src/example.js"] }), /index unavailable/);
  assert.equal(reads(), 0);
});

test("empty relevant tree rejects without source access", async (t) => {
  const { planner, reads } = await fixture(t);
  await assert.rejects(planner.plan({ relevantTree: [] }), /requires a relevant tree/);
  assert.equal(reads(), 0);
});

test("path outside project remains denied by File Service", async (t) => {
  const { planner } = await fixture(t);
  await assert.rejects(planner.plan({ relevantTree: ["../outside.js"] }), /unsafe|protected|denied/i);
});
