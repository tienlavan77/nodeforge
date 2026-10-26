// Exercises offline regrouping, receipt compatibility, and crash recovery inside project scratch.
// Migration must preserve evidence bytes and refuse live owners, collisions, and changed rollback data.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, symlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { migrateRuntime } from "../../src/infrastructure/filesystem/runtime-migration.js";
import { fingerprintStore } from "../../src/infrastructure/filesystem/runtime-migration-files.js";
import { RUNTIME_GROUPS, RUNTIME_LAYOUT_FILE, RUNTIME_LAYOUT_LOCK, groupedRuntimePath, resolveRuntimePath, readRuntimeLayout } from "../../src/infrastructure/filesystem/runtime-layout.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { classify } from "../../bin/forge-runtime-clean.mjs";
import { acquireProcessLock } from "../../scripts/nodeforge-process-lock.mjs";
import { persistVerificationEnvironment, loadVerificationEnvironment, readVerificationEnvironmentFile } from "../../src/modules/supervisor/ticket-verification-environment.js";
import { latestTicketVerificationAttempt } from "../../src/modules/supervisor/ticket-verification-attempts.js";
import { createAgentExecutionCheckpointStore } from "../../src/modules/agent/agent-execution-checkpoint.js";
import { createReviewRecordStorage } from "../../src/modules/supervisor/review-record-storage.js";

/** Creates thirty legacy stores plus untouched state, with cleanup bound to the test lifetime. */
async function fixture(context) {
  const scratch = join(process.cwd(), ".forge/scratch");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "runtime-migration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const store of [...Object.values(RUNTIME_GROUPS).flat(), "nf", "wc", "queues", "protocol-storage"]) {
    await mkdir(join(root, ".forge/runtime", store), { recursive: true });
    await writeFile(join(root, ".forge/runtime", store, "evidence.json"), JSON.stringify({ ref: ".forge/runtime/" + store + "/evidence.json" }));
  }
  return root;
}

// Every mapped store moves once; historical paths remain valid and discoverable.
test("groups thirty stores, preserves receipts and untouched state, and rolls back", async (context) => {
  const root = await fixture(context);
  const files = createFileService({ projectRoot: root });
  assert.equal((await migrateRuntime(root)).moves.filter((move) => move.status === "planned").length, 30);
  assert.equal(readRuntimeLayout(root).layout, "legacy");
  assert.deepEqual(await migrateRuntime(root, { apply: true, offline: true }), { status: "grouped", moves: 30, files: 30 });
  for (const store of Object.values(RUNTIME_GROUPS).flat()) {
    const legacy = ".forge/runtime/" + store + "/evidence.json";
    assert.equal(await files.readFile({ path: legacy }), JSON.stringify({ ref: legacy }));
    assert.equal(await files.readFile({ path: groupedRuntimePath(legacy) }), JSON.stringify({ ref: legacy }));
    assert.deepEqual(await files.listFiles({ glob: ".forge/runtime/" + store + "/*.json" }), [legacy]);
    assert.deepEqual(await files.listFiles({ glob: groupedRuntimePath(".forge/runtime/" + store + "/*.json") }), [groupedRuntimePath(legacy)]);
    await assert.rejects(lstat(join(root, ".forge/runtime", store)), { code: "ENOENT" });
  }
  assert.equal((await files.listFiles({ glob: ".forge/runtime/**/evidence.json" })).length, 34);
  assert.equal((await files.listFiles({ glob: ".forge/runtime/agents/*/evidence.json" })).length, 7);
  assert.ok((await files.listDirectories({ glob: ".forge/runtime/agents/*" })).every((path) => path.startsWith(".forge/runtime/agents/")));
  assert.ok((await files.listDirectories({ glob: ".forge/runtime/agent-checkpoints" })).includes(".forge/runtime/agent-checkpoints"));
  assert.equal(await readFile(join(root, ".forge/runtime/nf/evidence.json"), "utf8"), '{"ref":".forge/runtime/nf/evidence.json"}');
  assert.equal((await migrateRuntime(root, { apply: true, offline: true })).status, "already_grouped");
  assert.equal((await migrateRuntime(root, { rollback: true, offline: true })).moves, 30);
  assert.equal(readRuntimeLayout(root).layout, "legacy");
  assert.equal((await migrateRuntime(root, { rollback: true, offline: true })).status, "already_legacy");
});

// Existing services resume against new storage without regenerating verification evidence.
test("FileService writes and verification filesystem reads use grouped storage", async (context) => {
  const root = await fixture(context);
  const bytes = Buffer.from("recorded dependency");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = [{ path: "src/dependency.js", sha256, mode: 0o644 }];
  const binding = await persistVerificationEnvironment(root, { files: [{ ...manifest[0], bytes }], manifest, sha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") });
  const jobRoot = join(root, ".forge/runtime/ticket-verification/TICKET-1/jobs");
  await mkdir(jobRoot, { recursive: true });
  await writeFile(join(jobRoot, "VERIFY-first.json"), "{}");
  await migrateRuntime(root, { apply: true, offline: true });
  assert.deepEqual(await loadVerificationEnvironment(root, binding), manifest);
  assert.deepEqual(await readVerificationEnvironmentFile(root, manifest[0]), bytes);
  const latest = await latestTicketVerificationAttempt({ projectRoot: root, taskId: "TICKET-1", context: { review_commit_sha: "abc", source_revision: 1 }, matchRunnerRevision: false,
    loadJob: async () => ({ job_id: "VERIFY-first", commit_sha: "abc", source_revision: 1, attempt: 1 }) });
  assert.equal(latest.job_id, "VERIFY-first");
  const files = createFileService({ projectRoot: root });
  const path = ".forge/runtime/agent-checkpoints/new.json";
  await files.atomicWrite({ path, content: "one", replace: false });
  files.atomicWriteSync({ path, content: "two" });
  assert.equal(files.readFileSync({ path }), "two");
  assert.equal(await readFile(resolveRuntimePath(root, path), "utf8"), "two");
  const lock = files.createLockSync({ path: ".forge/runtime/automatic-review-locks/test.lock" });
  await assert.rejects(migrateRuntime(root, { rollback: true, offline: true }), /Live state lock/);
  lock.release();
  await files.renameFile({ from: path, to: ".forge/runtime/agent-checkpoints/renamed.json" });
  await files.deleteFile({ path: ".forge/runtime/agent-checkpoints/renamed.json" });
  await assert.rejects(lstat(join(root, ".forge/runtime/agent-checkpoints")), { code: "ENOENT" });
});

// Explicit operator intent cannot bypass ownership, collisions, or linked endpoints.
test("refuses live daemon owners, missing offline mode, collisions and linked groups", async (context) => {
  const root = await fixture(context);
  await assert.rejects(migrateRuntime(root, { apply: true }), /offline/);
  const lock = acquireProcessLock(join(root, ".forge/runtime/nf"), "control", { projectRoot: root });
  await assert.rejects(migrateRuntime(root, { apply: true, offline: true }), /Live control/);
  lock.release();
  await mkdir(join(root, ".forge/runtime/agents/agent-checkpoints"), { recursive: true });
  await assert.rejects(migrateRuntime(root, { apply: true, offline: true }), /conflict/);
  await rm(join(root, ".forge/runtime/agents"), { recursive: true });
  await symlink(join(root, ".forge/runtime/nf"), join(root, ".forge/runtime/agents"));
  await assert.rejects(migrateRuntime(root, { apply: true, offline: true }), /Invalid group/);
  assert.equal(readRuntimeLayout(root).layout, "legacy");
});

// A partial migration blocks both existing readers and newly starting daemons.
test("rolls back a partial move while fencing readers and daemon startup", async (context) => {
  const root = await fixture(context);
  const files = createFileService({ projectRoot: root });
  const from = ".forge/runtime/agent-checkpoints", to = groupedRuntimePath(from);
  const fingerprint = await fingerprintStore(join(root, from));
  await writeFile(join(root, RUNTIME_LAYOUT_FILE), JSON.stringify({ version: 1, layout: "legacy", status: "migrating", moves: [{ from, to, fingerprint }] }));
  await mkdir(join(root, ".forge/runtime/agents"));
  await rename(join(root, from), join(root, to));
  assert.throws(() => createFileService({ projectRoot: root }), /incomplete/);
  await assert.rejects(files.readFile({ path: from + "/evidence.json" }), /incomplete/);
  assert.throws(() => acquireProcessLock(join(root, ".forge/runtime/nf"), "watcher", { projectRoot: root }), /incomplete/);
  assert.equal((await migrateRuntime(root, { rollback: true, offline: true })).status, "legacy");
  assert.equal(await files.readFile({ path: from + "/evidence.json" }), JSON.stringify({ ref: from + "/evidence.json" }));
});

// Evidence written after cutover must never be discarded by rollback.
test("rejects changed evidence and tampered journal endpoints before rollback", async (context) => {
  const root = await fixture(context);
  await migrateRuntime(root, { apply: true, offline: true });
  const path = resolveRuntimePath(root, ".forge/runtime/agent-checkpoints/evidence.json");
  const bytes = await readFile(path);
  await writeFile(path, "changed");
  await assert.rejects(migrateRuntime(root, { rollback: true, offline: true }), /evidence changed/);
  assert.equal(readRuntimeLayout(root).layout, "grouped");
  await writeFile(path, bytes);
  const marker = readRuntimeLayout(root);
  marker.moves[0].to = "../escape";
  await writeFile(join(root, RUNTIME_LAYOUT_FILE), JSON.stringify(marker));
  await assert.rejects(migrateRuntime(root, { rollback: true, offline: true }), /journal endpoints/);
});

// Cleanup and startup must honor the new grouped roots and fencing metadata.
test("cleanup preserves grouped roots and an existing fence blocks writers", async (context) => {
  const root = await fixture(context);
  const names = [...Object.keys(RUNTIME_GROUPS), "runtime-layout.json", ".runtime-layout.lock"];
  const result = classify(names.map((name) => ({ name, kind: name.includes(".") ? "file" : "directory" })));
  assert.deepEqual(result.keep, names);
  assert.deepEqual(result.garbage, []);
  await writeFile(join(root, RUNTIME_LAYOUT_LOCK), String(process.pid));
  assert.throws(() => createFileService({ projectRoot: root }), /fenced/);
  assert.throws(() => acquireProcessLock(join(root, ".forge/runtime/nf"), "control", { projectRoot: root }), /fenced/);
  await assert.rejects(migrateRuntime(root, { apply: true, offline: true }), /Another migration/);
});

// Real checkpoint and review stores retain byte identity across migration and can resume afterwards.
test("checkpoint and review services resume against grouped storage", async (context) => {
  const root = await fixture(context);
  const fileService = createFileService({ projectRoot: root });
  const checkpoints = createAgentExecutionCheckpointStore({ fileService });
  await checkpoints.save({ task_id: "T-M", attempt: 1, last_completed_turn: 3 });
  const saved = await checkpoints.load("T-M");
  const reviews = createReviewRecordStorage({ taskId: "T-M", fileService });
  const state = { task_id: "T-M", version: 1, next_id: 1, findings: [], coder_reports: [], coder_responses: [], adjudications: [] };
  await reviews.save(state);
  await migrateRuntime(root, { apply: true, offline: true });
  assert.deepEqual(await checkpoints.load("T-M"), saved);
  assert.deepEqual(await reviews.load(), state);
  await checkpoints.save({ ...saved, last_completed_turn: 4 });
  assert.equal((await checkpoints.load("T-M")).last_completed_turn, 4);
  assert.equal(JSON.parse(await readFile(resolveRuntimePath(root, ".forge/runtime/agent-checkpoints/T-M.json"), "utf8")).last_completed_turn, 4);
});

// Moving links with relative targets or links back into moved state would invalidate their meaning.
test("refuses relocation-sensitive links and Git workspaces before publishing a journal", async (context) => {
  const root = await fixture(context);
  const store = join(root, ".forge/runtime/agent-checkpoints");
  const link = join(store, "dependency");
  await symlink("../nf", link);
  await assert.rejects(migrateRuntime(root, { apply: true, offline: true }), /Relative link/);
  await rm(link);
  await symlink(join(root, ".forge/runtime/review-records"), link);
  await assert.rejects(migrateRuntime(root, { apply: true, offline: true }), /Link into moved state/);
  await rm(link);
  await writeFile(join(store, ".git"), "gitdir: retained-worktree");
  await assert.rejects(migrateRuntime(root, { apply: true, offline: true }), /Git workspace/);
  await assert.rejects(lstat(join(root, RUNTIME_LAYOUT_FILE)), { code: "ENOENT" });
});

// Projects with missing stores create them under the selected layout without affecting other projects.
test("missing stores and project-local layout selection remain isolated", async (context) => {
  const root = await fixture(context);
  const other = await fixture(context);
  await rm(join(root, ".forge/runtime/agent-checkpoints"), { recursive: true });
  assert.equal((await migrateRuntime(root, { apply: true, offline: true })).moves, 29);
  const path = ".forge/runtime/agent-checkpoints/new.json";
  await createFileService({ projectRoot: root }).atomicWrite({ path, content: "new", replace: false });
  assert.equal(await readFile(join(root, groupedRuntimePath(path)), "utf8"), "new");
  assert.equal(resolveRuntimePath(other, path), join(other, path));
  assert.equal(readRuntimeLayout(other).layout, "legacy");
  await assert.rejects(migrateRuntime(root, { rollback: true, offline: true }), /Unjournaled grouped/);
  await mkdir(join(other, ".forge/runtime/agents"));
  await rename(join(other, ".forge/runtime/agent-checkpoints"), join(other, ".forge/runtime/agents/agent-checkpoints"));
  await assert.rejects(migrateRuntime(other, { rollback: true, offline: true }), /Unjournaled grouped/);
});
