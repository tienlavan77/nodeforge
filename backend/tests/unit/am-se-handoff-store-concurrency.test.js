// Business purpose: confirms durable handoff claims are exclusive across real FileService instances.
// Technical description: uses an isolated project directory to exercise create, guarded generation transitions, and stale result rejection.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAmSeHandoffStore } from "../../src/application/am-se-handoff-store.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

test("production store refuses duplicate handoff and fences concurrent completions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "handoff-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fileService = createFileService({ projectRoot: root });
  const first = createAmSeHandoffStore({ projectId: "PROJECT-TEST", fileService });
  const second = createAmSeHandoffStore({ projectId: "PROJECT-TEST", fileService });
  const fields = { handoffId: "HANDOFF-TEST", planId: "PLAN-TEST", planRevision: 2, planSha256: "reviewed", planSourcePath: "source.json" };
  const created = await first.create(fields);
  assert.equal(created.plan_revision, 2);
  await assert.rejects(second.create(fields), { code: "HANDOFF_ALREADY_EXISTS" });
  const initialized = await first.transition(fields.handoffId, 0, (current) => ({ ...current, checkpoint: { generation: 0, plan_locked: true, execution_status: "pending", results: [] } }));
  assert.equal(initialized.checkpoint.generation, 1);
  const attempted = await Promise.allSettled([first.transition(fields.handoffId, 1, (current) => ({ ...current, checkpoint: { ...current.checkpoint, execution_status: "running", execution_id: "attempt-a" } })), second.transition(fields.handoffId, 1, (current) => ({ ...current, checkpoint: { ...current.checkpoint, execution_status: "running", execution_id: "attempt-b" } }))]);
  assert.equal(attempted.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(attempted.find((result) => result.status === "rejected").reason.code, "HANDOFF_STALE");
  const persisted = await second.get(fields.handoffId);
  assert.equal(persisted.checkpoint.generation, 2);
  await assert.rejects(first.update(fields.handoffId, { plan_sha256: "forged" }), { code: "HANDOFF_CHECKPOINT_TRANSITION_REQUIRED" });
  await assert.rejects(second.transition(fields.handoffId, 2, (current) => ({ ...current, plan_sha256: "forged" })), { code: "HANDOFF_PLAN_LOCKED" });
});
