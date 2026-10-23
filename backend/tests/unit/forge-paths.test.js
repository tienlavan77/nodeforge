// Verifies the runtime-state path helpers are the single source of truth for `.forge/runtime` layout.
import assert from "node:assert/strict";
import test from "node:test";
import { FORGE_DIR, FORGE_STATE_DIR, FORGE_SCRATCH_DIR, STATE_DIR_PREFIX, statePath, scratchPath } from "../../src/infrastructure/filesystem/forge-paths.js";

test("derives the runtime-state root and prefix without a trailing slash mismatch", () => {
  assert.equal(FORGE_DIR, ".forge");
  assert.equal(FORGE_STATE_DIR, ".forge/runtime");
  assert.equal(STATE_DIR_PREFIX, ".forge/runtime/");
});

test("statePath joins segments with forward slashes and skips empty segments", () => {
  assert.equal(statePath(), ".forge/runtime");
  assert.equal(statePath("supervisor-queues"), ".forge/runtime/supervisor-queues");
  assert.equal(statePath("nf", "plans", "p1"), ".forge/runtime/nf/plans/p1");
  assert.equal(statePath("a", "", undefined, null, "b"), ".forge/runtime/a/b");
});

test("scratchPath is a distinct disposable root from the state root", () => {
  assert.equal(FORGE_SCRATCH_DIR, ".forge/scratch");
  assert.equal(scratchPath(), ".forge/scratch");
  assert.equal(scratchPath("tmp", "x.json"), ".forge/scratch/tmp/x.json");
  assert.notEqual(scratchPath("x"), statePath("x"));
});
