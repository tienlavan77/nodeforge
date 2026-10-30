/**
 * Consolidates the final Phase B evidence for Owner and AM without replacing
 * raw failed test receipts. It validates all 74 core test-file assertion hashes,
 * their shared before/current failure diagnostics, unchanged core source bytes
 * and all eleven retrieval case metrics against the official pre-source baseline.
 * Timing fields are excluded only from retrieval score comparison.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

// Resolves local evidence in the repository rather than depending on API state.
const root = resolve(new URL("../../", import.meta.url).pathname);
const reports = ".forge/runtime/reports/";

// Reads the full artifact on disk so large raw diagnostics are not truncated by
// a bounded tool response while consolidating the small acceptance summary.
async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

// Retains score, missing-path and semantic-match fields while excluding timing.
function metric(record) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !["duration_ms", "at"].includes(key)));
}

// Verifies the final evidence boundary without changing any production assertion,
// expected source identity or runtime policy outside source restructuring.
test("Phase B final core and retrieval evidence remain consistent", async () => {
  const plan = await json(reports + "phase-b3-6-plan.json");
  const groups = [1, 2, 3, 4, 5, "6-sprint-isolated", "6-remaining", 7, 8];
  const summaries = []; const covered = [];
  for (const group of groups) {
    const path = reports + "phase-b3-6-comparison-" + group + ".json";
    const evidence = await json(path);
    assert.ok(evidence.environment_sha256);
    assert.deepEqual(evidence.current.assertions, evidence.baseline.assertions);
    const scheduling = /^ {4}process\.processTicksAndRejections \(node:internal\/process\/task_queues:\d+:\d+\)\n/gm;
    assert.deepEqual(evidence.current.failures.map((block) => block.replace(scheduling, "")),
      evidence.baseline.failures.map((block) => block.replace(scheduling, "")));
    assert.equal(evidence.current.exit_code, evidence.baseline.exit_code);
    covered.push(...evidence.current.assertions.map((entry) => entry.path));
    summaries.push({ path, environment_sha256: evidence.environment_sha256,
      files: evidence.current.assertions.length, raw_exit_code: evidence.current.exit_code,
      failure_blocks: evidence.current.failures.length,
      failing_files: [...new Set(evidence.current.failures.flatMap((block) =>
        [...block.matchAll(/backend\/tests\/[^:'"\n]+\.test\.(?:js|mjs)/g)].map(([path]) => path)))] });
  }
  assert.deepEqual(covered.sort(), [...plan.tests].sort());
  assert.equal(new Set(covered).size, 74);
  for (const core of plan.core) {
    const source = await readFile(resolve(root, core.path));
    assert.equal("sha256:" + createHash("sha256").update(source).digest("hex"), core.before_checksum);
  }
  const progressSource = await readFile(resolve(root, reports + "retrieval-benchmark-progress.jsonl"), "utf8");
  const records = progressSource.trim().split("\n").map((line) => JSON.parse(line));
  const baseline = await json(reports + "retrieval-benchmark-before-source.json");
  const phases = new Set(["case_completed", "completed"]);
  assert.equal(records.filter((record) => record.phase === "case_completed").length, 11);
  assert.equal(records.at(-1).phase, "completed");
  assert.deepEqual(records.filter((record) => phases.has(record.phase)).map(metric),
    baseline.records.filter((record) => phases.has(record.phase)).map(metric));
  const retrieval = { purpose: "Preserves final B.3.6 retrieval metrics before any subsequent run.",
    records, baseline: reports + "retrieval-benchmark-before-source.json", metrics_equal: true };
  await writeFile(resolve(root, reports + "phase-b3-6-retrieval-completed.json"), JSON.stringify(retrieval) + "\n");
  const audit = await json(reports + "phase-b3-6-dependency-audit.json");
  assert.deepEqual(audit.current_edges, audit.baseline_edges);
  assert.deepEqual(audit.current_cycles, audit.baseline_cycles);
  assert.deepEqual(audit.missing_local_imports, []);
  const summary = { purpose: "Final evidence validation, separate from Owner/AM acceptance and raw runtime test success.",
    core_unchanged: plan.core.length, core_test_files: covered.length, comparisons: summaries,
    raw_failure_blocks: summaries.reduce((sum, entry) => sum + entry.failure_blocks, 0),
    dependency_edges: audit.current_edges.length, existing_cycles: audit.current_cycles,
    computed_imports: audit.computed_imports, retrieval: records.at(-1), metrics_equal: true };
  await writeFile(resolve(root, reports + "phase-b3-6-final-evidence.json"), JSON.stringify(summary) + "\n");
  console.log(JSON.stringify(summary));
});
