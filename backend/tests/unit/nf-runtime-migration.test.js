// Verifies functional nf regrouping, historical byte references, SDK absolute rollout paths,
// independent migration journals, and recovery gates using only project-local scratch fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, readFile, rm, lstat, readlink, symlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { NF_RUNTIME_ROOT, NF_RUNTIME_GROUPS, NF_LAYOUT_FILE, NF_LAYOUT_LOCK, groupedNfRuntimePath, readNfRuntimeLayout } from "../../src/infrastructure/filesystem/nf-runtime-layout.js";
import { migrateNfRuntime, previewNfMigration } from "../../src/infrastructure/filesystem/nf-runtime-migration.js";
import { fingerprintStore } from "../../src/infrastructure/filesystem/runtime-migration-files.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { resolveRuntimePath } from "../../src/infrastructure/filesystem/forge-paths.js";
import { createProjectLogService } from "../../src/core/project-log-service.js";
import { acquireProcessLock } from "../../scripts/nodeforge-process-lock.mjs";
import { codexShellEnvironment } from "../../src/modules/agent/codex-shell-environment.js";

/** Supplies explicit maintenance intent only for isolated fixture operations. */
const offline = { offline: true, sdkStopped: true };

/** Builds representative nf stores and untouched configuration beneath the project scratch root. */
async function fixture(context) {
  const scratch = join(process.cwd(), ".forge/scratch");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "nf-migration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const store of Object.values(NF_RUNTIME_GROUPS).flat().filter(store => store !== "sdk-cache")) {
    await mkdir(join(root, NF_RUNTIME_ROOT, store), { recursive: true });
    await writeFile(join(root, NF_RUNTIME_ROOT, store, "evidence.json"), JSON.stringify({ ref: NF_RUNTIME_ROOT + "/" + store + "/evidence.json" }));
  }
  await mkdir(join(root, NF_RUNTIME_ROOT, "logs"));
  for (const name of ["project.log", "project.log.7"]) await writeFile(join(root, NF_RUNTIME_ROOT, name), "");
  for (const name of ["agent-config.json", "secrets.vault"]) await writeFile(join(root, NF_RUNTIME_ROOT, name), "untouched");
  await writeFile(join(root, ".forge/runtime/runtime-layout.json"), JSON.stringify({ version: 1, layout: "grouped", status: "ready", moves: [] }));
  return root;
}

// Moving nf must preserve the earlier pipeline journal, old receipt names, and explicit grouped discovery.
test("nf apply and rollback preserve references and the thirty-store migration journal", async context => {
  const root = await fixture(context), files = createFileService({ projectRoot: root });
  const pipeline = await readFile(join(root, ".forge/runtime/runtime-layout.json"));
  const preview = await previewNfMigration(root);
  assert.equal(preview.moves.filter(move => move.status === "planned").length, 16);
  assert.deepEqual(preview.blockers, []);
  assert.equal(readNfRuntimeLayout(root).layout, "legacy");
  assert.deepEqual(await migrateNfRuntime(root, { apply: true, ...offline }), { status: "grouped", moves: 16, sdkAliases: 1 });
  for (const store of Object.values(NF_RUNTIME_GROUPS).flat().filter(store => store !== "sdk-cache")) {
    const path = NF_RUNTIME_ROOT + "/" + store + "/evidence.json";
    assert.equal(await files.readFile({ path }), JSON.stringify({ ref: path }));
    assert.deepEqual(await files.listFiles({ glob: NF_RUNTIME_ROOT + "/" + store + "/*.json" }), [path]);
    assert.deepEqual(await files.listFiles({ glob: groupedNfRuntimePath(NF_RUNTIME_ROOT + "/" + store + "/*.json") }), [groupedNfRuntimePath(path)]);
  }
  assert.equal((await files.listFiles({ glob: NF_RUNTIME_ROOT + "/planning/*/evidence.json" })).length, 3);
  assert.equal(await readFile(join(root, NF_RUNTIME_ROOT, "secrets.vault"), "utf8"), "untouched");
  assert.deepEqual(await readFile(join(root, ".forge/runtime/runtime-layout.json")), pipeline);
  assert.equal((await migrateNfRuntime(root, { apply: true, ...offline })).status, "already_grouped");
  assert.equal((await migrateNfRuntime(root, { rollback: true, ...offline })).status, "legacy");
  assert.equal((await lstat(join(root, NF_RUNTIME_ROOT, "codex-homes"))).isSymbolicLink(), false);
  assert.deepEqual(await readFile(join(root, ".forge/runtime/runtime-layout.json")), pipeline);
});

// SDK SQLite may retain absolute rollout paths; the fixed alias keeps those paths readable byte for byte.
test("complete SDK homes retain absolute session paths, internal links and standalone plugin repositories", async context => {
  const root = await fixture(context), home = join(root, NF_RUNTIME_ROOT, "codex-homes/AGENT");
  await mkdir(join(home, "sessions"), { recursive: true });
  const rollout = join(home, "sessions/thread.jsonl");
  await writeFile(rollout, "retained session\n");
  await symlink("sessions/thread.jsonl", join(home, "thread-link"));
  await mkdir(join(home, ".tmp/plugins/.git"), { recursive: true });
  await writeFile(join(home, ".tmp/plugins/.git/config"), "[core]\n bare = false\n");
  const database = new DatabaseSync(join(home, "state_5.sqlite"));
  database.exec("CREATE TABLE threads(rollout_path TEXT)");
  database.prepare("INSERT INTO threads VALUES (?)").run(rollout);
  database.close();
  const before = await readFile(join(home, "state_5.sqlite"));
  await migrateNfRuntime(root, { apply: true, ...offline });
  assert.equal(await readlink(join(root, NF_RUNTIME_ROOT, "codex-homes")), "sdk/codex-homes");
  const groupedHome = resolveRuntimePath(root, NF_RUNTIME_ROOT + "/codex-homes/AGENT");
  const read = new DatabaseSync(join(groupedHome, "state_5.sqlite"), { readOnly: true });
  try { assert.equal(await readFile(read.prepare("SELECT rollout_path FROM threads").get().rollout_path, "utf8"), "retained session\n"); }
  finally { read.close(); }
  assert.deepEqual(await readFile(join(groupedHome, "state_5.sqlite")), before);
  assert.equal(await readFile(join(groupedHome, "thread-link"), "utf8"), "retained session\n");
  assert.equal(codexShellEnvironment({}, root).XDG_CACHE_HOME, join(root, NF_RUNTIME_ROOT, "sdk/sdk-cache"));
  assert.equal((await migrateNfRuntime(root, { rollback: true, ...offline })).status, "legacy");
});

// Existing JSONL index offsets and plan permissions remain valid without rewriting stored database values.
test("historical byte offsets, plan permissions and log reads work after regrouping", async context => {
  const root = await fixture(context), files = createFileService({ projectRoot: root });
  const path = NF_RUNTIME_ROOT + "/conversation-migrations/project.jsonl";
  const first = files.appendFileSync({ path, content: "first\n" });
  const second = files.appendFileSync({ path, content: "second\n" });
  const logs = createProjectLogService({ projectRoot: root, fileService: files });
  await migrateNfRuntime(root, { apply: true, ...offline });
  assert.equal(files.readFileRangeSync({ path, offset: first.byte_offset, length: first.byte_length }), "first\n");
  assert.equal(files.readFileRangeSync({ path, offset: second.byte_offset, length: second.byte_length }), "second\n");
  const plans = createFileService({ projectRoot: root, allowPlanStorage: true, role: "architecture_manager" });
  await plans.atomicWrite({ path: NF_RUNTIME_ROOT + "/planning/plans/PLAN/1.md", content: "# Plan", replace: false });
  assert.equal(await plans.readFile({ path: NF_RUNTIME_ROOT + "/plans/PLAN/1.md" }), "# Plan");
  logs.logEvent({ timestamp: "2026-10-26T00:00:00.000Z", source: "nf-migration-test", event_name: "ticket.started", level: "info", status: "info", message: "fixture", task_id: "TASK-NF", project_id: "PROJECT-NF" });
  assert.equal((await logs.readLogEvents({ task_id: "TASK-NF" })).events.length, 1);
  const moduleUrl = new URL("../../src/core/project-log-service.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    "const {readLogEvents}=await import(" + JSON.stringify(moduleUrl) + "); console.log((await readLogEvents({task_id:'TASK-NF'})).events.length);"],
  { cwd: root, env: { ...process.env, NODEFORGE_PROJECT_LOG_PATH: NF_RUNTIME_ROOT + "/project.log" }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "1");
  assert.equal((await lstat(join(root, NF_RUNTIME_ROOT, "logs/project.log.7"))).isFile(), true);
  await assert.rejects(migrateNfRuntime(root, { rollback: true, ...offline }), /evidence changed/);
});

// Neither a flag nor an opaque SDK lock substitutes for explicit shutdown and daemon ownership checks.
test("nf migration refuses live owners, absent SDK confirmation, collisions and active fences", async context => {
  const root = await fixture(context);
  await assert.rejects(migrateNfRuntime(root, { apply: true, offline: true }), /sdk-stopped/);
  const lock = acquireProcessLock(join(root, NF_RUNTIME_ROOT), "control", { projectRoot: root });
  assert.match((await previewNfMigration(root)).blockers.join(" "), /Live control/);
  await assert.rejects(migrateNfRuntime(root, { apply: true, ...offline }), /Live control/);
  lock.release();
  await mkdir(join(root, NF_RUNTIME_ROOT, "planning/plans"), { recursive: true });
  await assert.rejects(migrateNfRuntime(root, { apply: true, ...offline }), /conflict/);
  await rm(join(root, NF_RUNTIME_ROOT, "planning"), { recursive: true });
  await writeFile(join(root, NF_LAYOUT_LOCK), String(process.pid));
  assert.throws(() => createFileService({ projectRoot: root }), /fenced/);
  assert.throws(() => acquireProcessLock(join(root, NF_RUNTIME_ROOT), "watcher", { projectRoot: root }), /fenced/);
  await assert.rejects(migrateNfRuntime(root, { apply: true, ...offline }), /Another migration/);
});

// Recovery locates stores on either side of an interrupted rename and rejects edited journal paths.
test("partial nf migration is fenced and rollback restores unchanged stores", async context => {
  const root = await fixture(context), from = NF_RUNTIME_ROOT + "/conversations", to = groupedNfRuntimePath(from);
  const fingerprint = await fingerprintStore(join(root, from), { allowInternalLinks: true });
  await writeFile(join(root, NF_LAYOUT_FILE), JSON.stringify({ version: 1, layout: "legacy", status: "migrating", moves: [{ from, to, fingerprint }], aliases: [], createdGroups: ["history"] }));
  await mkdir(join(root, NF_RUNTIME_ROOT, "history"));
  await rename(join(root, from), join(root, to));
  assert.throws(() => createFileService({ projectRoot: root }), /incomplete/);
  assert.equal((await migrateNfRuntime(root, { rollback: true, ...offline })).status, "legacy");
  assert.equal((await lstat(join(root, from))).isDirectory(), true);
  await migrateNfRuntime(root, { apply: true, ...offline });
  const marker = readNfRuntimeLayout(root);
  marker.moves[0].to = "../escape";
  await writeFile(join(root, NF_LAYOUT_FILE), JSON.stringify(marker));
  await assert.rejects(migrateNfRuntime(root, { rollback: true, ...offline }), /journal endpoints/);
});

// The SDK alias exception must not authorize arbitrary links, and real worktrees must still block apply.
test("SDK worktrees and forged compatibility aliases are rejected before any move", async context => {
  const root = await fixture(context);
  const home = join(root, NF_RUNTIME_ROOT, "codex-homes/AGENT");
  await mkdir(home);
  await writeFile(join(home, ".git"), "gitdir: ../retained");
  assert.match((await previewNfMigration(root)).blockers.join(" "), /Git workspace/);
  await assert.rejects(migrateNfRuntime(root, { apply: true, ...offline }), /Git workspace/);
  await assert.rejects(lstat(join(root, NF_LAYOUT_FILE)), { code: "ENOENT" });
  await rm(join(root, NF_RUNTIME_ROOT, "codex-homes"), { recursive: true });
  await symlink("logs", join(root, NF_RUNTIME_ROOT, "codex-homes"));
  await assert.rejects(previewNfMigration(root), /Unsafe nf source/);
});
