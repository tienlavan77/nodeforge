// Verifies event-level shadow identity records survive restart without changing ticket outcomes.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketPipelineShadow } from "../../src/modules/supervisor/ticket-pipeline-shadow.js";

// Writes compact persisted identity fixtures through File Service.
async function save(files, path, value) { await files.atomicWrite({ path, content: `${JSON.stringify(value)}\n`, replace: true }); }

test("shadow comparison persists match, survives restart, and records later drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-shadow-"));
  const projectId = "PROJECT-SHADOW";
  const taskId = "TICKET-SHADOW";
  const projectHash = createHash("sha256").update(projectId).digest("hex");
  try {
    const files = createFileService({ projectRoot: root });
    const context = { task_id: taskId, project_id: projectId, version: 4, base_sha: "base", source_revision: "source", manifest_sha: "manifest", manifest_paths: ["backend/src/a.js"], review_commit_sha: "commit", verification_artifact_id: "ARTIFACT-1" };
    const artifact = { artifact_id: "ARTIFACT-1", base_sha: "base", source_revision: "source", manifest_sha: "manifest", commit_sha: "commit", file_checksums: { "backend/src/a.js": "sha256:a" } };
    await save(files, `.forge/runtime/ticket-execution-contexts/${projectHash}/${taskId}.json`, context);
    await save(files, `.forge/runtime/ticket-verification/${taskId}/artifacts/ARTIFACT-1.json`, artifact);
    await save(files, `.forge/runtime/reviewer-checkpoints/${taskId}.json`, { task_id: taskId, status: "completed", verdict: "approved", reviewer_id: "REVIEWER-1", verification: { artifact_id: "ARTIFACT-1" } });
    await save(files, `.forge/runtime/ticket-integrations/${taskId}.json`, { task_id: taskId, status: "completed", reviewed_commit: "commit", commit: "commit" });
    const rollout = { load: async () => ({ mode: "shadow" }) };
    const first = createTicketPipelineShadow({ projectId, fileService: files, rollout });
    const event = { event_id: "EVT-SHADOW-1", type: "task.completed", task_id: taskId };
    assert.equal((await first.compare({ ...event, event_id: "EVT-VERIFY", type: "verification.passed" })).status, "match");
    assert.equal((await first.compare({ ...event, event_id: "EVT-REVIEW", type: "review.approved" })).status, "match");
    const matched = await first.compare(event);
    assert.equal(matched.status, "match");
    assert.equal(matched.identity.artifact_id, "ARTIFACT-1");
    const restarted = createTicketPipelineShadow({ projectId, fileService: files, rollout });
    assert.deepEqual(await restarted.compare(event), matched);
    artifact.manifest_sha = "changed-manifest";
    await save(files, `.forge/runtime/ticket-verification/${taskId}/artifacts/ARTIFACT-1.json`, artifact);
    await files.atomicWrite({ path: `.forge/runtime/ticket-pipeline-shadow/${projectHash}/EVT-SHADOW-2.json.lock`, content: "99999999:abandoned\n", replace: true });
    const drift = await restarted.compare({ ...event, event_id: "EVT-SHADOW-2" });
    assert.equal(drift.status, "mismatch");
    assert.equal(drift.checks.manifest_sha, false);
    assert.equal((await restarted.compare({ ...event, event_id: "EVT-SHADOW-2" })).compared_at, drift.compared_at);
    assert.equal((await restarted.compare({ ...event, event_id: "EVT-MISSING", task_id: "TICKET-MISSING" })).status, "unavailable");
    assert.equal(await createTicketPipelineShadow({ projectId, fileService: files, rollout: { load: async () => ({ mode: "enforce" }) } }).compare({ ...event, event_id: "EVT-SHADOW-3" }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
