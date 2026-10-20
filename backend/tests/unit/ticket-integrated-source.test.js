// Verifies review repairs recognize integrated dependencies while rejecting external or unbound changes.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { findIntegratedTicketSource } from "../../src/modules/supervisor/ticket-integrated-source.js";

// Supplies a completed integration whose source is pinned to the current project and exact commit.
function fixture() {
  const receipt = { task_id: "OTHER", status: "completed", workspace_mode: "root-only", commit: "c", reviewed_commit: "c", artifact_id: "A", manifest_sha: "M", source_revision: "S" };
  const context = { task_id: "OTHER", project_id: "P", state: "terminal", review_commit_sha: "c", verification_artifact_id: "A", manifest_sha: "M", source_revision: "S", manifest_paths: ["source.js"] };
  let reachable = true;
  const options = { path: "source.js", sha256: createHash("sha256").update("integrated").digest("hex"), taskId: "T", projectId: "P",
    fileService: { listFiles: async () => ["receipt.json"], readFile: async () => JSON.stringify(receipt) },
    executionContexts: { load: async () => context }, rootGit: { assertAncestor: async () => { if (!reachable) throw new Error("not reachable"); }, fileAt: async () => "integrated" } };
  return { options, receipt, context, unreachable: () => { reachable = false; } };
}

test("only completed same-project reachable integration admits exact bytes", async () => {
  const f = fixture();
  assert.deepEqual(await findIntegratedTicketSource(f.options), { task_id: "OTHER", commit: "c", artifact_id: "A" });
  assert.equal(await findIntegratedTicketSource({ ...f.options, sha256: "0".repeat(64) }), null);
  assert.equal(await findIntegratedTicketSource({ ...f.options, projectId: "FOREIGN" }), null);
  f.context.state = "coding";
  assert.equal(await findIntegratedTicketSource(f.options), null);
  f.context.state = "terminal";
  f.receipt.artifact_id = "UNBOUND";
  assert.equal(await findIntegratedTicketSource(f.options), null);
  f.receipt.artifact_id = "A";
  f.unreachable();
  await assert.rejects(findIntegratedTicketSource(f.options), /not reachable/);
});

test("completed integration can prove a carried source when the old manifest omitted the path", async () => {
  const f = fixture();
  f.context.manifest_paths = [];
  assert.deepEqual(await findIntegratedTicketSource(f.options), { task_id: "OTHER", commit: "c", artifact_id: "A" });
});
