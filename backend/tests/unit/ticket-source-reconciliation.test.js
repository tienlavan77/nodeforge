// Verifies Node supplies source-conflict evidence without mutating journals, Git, or ticket authority.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { inspectTicketSource } from "../../src/modules/supervisor/ticket/ticket-source-reconciliation.js";

// Supplies read-only services and a journal whose contents must never reach the model.
function fixture() {
  const hash = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const entry = { initial_sha: hash("dirty"), latest_sha: hash("after"), initial_content: "SECRET SOURCE",
    operations: [{ id: "OP", revision: 1, before_sha: hash("dirty"), after_sha: hash("after"), before: "SECRET", after: "SECRET" }] };
  const manifest = { task_id: "T", project_id: "P", revision: 1, commits: {}, pending_commit: null, entries: { "router.js": entry } };
  const reads = [];
  return { taskId: "T", projectId: "P", manifest,
    rootGit: { assertSafePath: async (path) => { reads.push(path); }, fileAt: async () => "parent" },
    gitService: { getHead: async () => "HEAD" }, loadJournal: async () => null, loadManifest: async () => structuredClone(manifest), reads, hash };
}

test("Node exposes exact operation hashes and absent transaction without inventing a failed parent", async () => {
  const f = fixture();
  const before = structuredClone(f.manifest);
  const result = await inspectTicketSource(f);
  assert.equal(result.status, "observed");
  assert.equal(result.observation, "current_parent_not_historical_failed_parent");
  assert.equal(result.transaction.status, "missing");
  assert.equal(result.files[0].comparison, "preexisting_changes");
  assert.equal(result.commit_scope, "whole_ticket_files");
  assert.equal(result.files[0].parent_file_sha256, f.hash("parent"));
  assert.deepEqual(result.files[0].operations, [{ id: "OP", revision: 1, before_sha: f.hash("dirty"), after_sha: f.hash("after") }]);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.deepEqual(f.manifest, before);
  assert.deepEqual(f.reads, ["router.js"]);
  assert.equal((await inspectTicketSource(f)).sha256, result.sha256);
});

test("current parent comparisons follow commit preflight states and preserve retained transaction identity", async () => {
  const f = fixture();
  f.loadJournal = async () => ({ transaction_id: "TX", revision: 1, parent_sha: "HISTORICAL", phase: "prepared", private_source: "SECRET" });
  for (const [content, comparison] of [["dirty", "recorded_ticket_state"], ["after", "already_in_parent"], [null, "preexisting_changes"]]) {
    f.rootGit.fileAt = async () => content;
    const result = await inspectTicketSource(f);
    assert.equal(result.files[0].comparison, comparison);
    assert.equal(result.transaction.parent_sha, "HISTORICAL");
    assert.equal(result.parent_sha, "HEAD");
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
  }
});

test("HEAD movement or ledger change makes observations stale and service failures propagate", async () => {
  const f = fixture();
  let count = 0;
  f.gitService.getHead = async () => ++count === 1 ? "BEFORE" : "AFTER";
  assert.equal((await inspectTicketSource(f)).status, "stale");
  f.gitService.getHead = async () => "HEAD";
  f.loadManifest = async () => ({ ...f.manifest, revision: 2 });
  assert.equal((await inspectTicketSource(f)).status, "stale");
  f.rootGit.fileAt = async () => { throw new Error("Git unavailable"); };
  await assert.rejects(inspectTicketSource(f), /Git unavailable/);
});

test("source evidence cannot cross project or ticket scope", async () => {
  for (const mismatch of [{ taskId: "OTHER" }, { projectId: "OTHER" }]) {
    const f = fixture();
    await assert.rejects(inspectTicketSource({ ...f, ...mismatch }), { code: "TICKET_COMMIT_SCOPE" });
    assert.deepEqual(f.reads, []);
  }
});
