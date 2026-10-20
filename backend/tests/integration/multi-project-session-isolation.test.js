// Proves redirected session storage cannot read or modify another project's runtime artifacts.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createSessionStore } from "../../src/modules/projects/session-store.js";
import { ensureRuntimeDir, openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";

// Preserves first-use runtime creation without allowing missing roots to bypass linked-directory checks.
test("initializes missing runtime data roots while rejecting redirected missing storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-runtime-first-use-"));
  const dataRoot = join(directory, "first", ".forge/runtime/nf");
  let database;
  try {
    database = await openIndexDatabase(dataRoot, { runtimeDir: "." });
    assert.equal(database.databasePath, join(dataRoot, "index.db"));
    assert.deepEqual(database.all("PRAGMA quick_check"), [{ quick_check: "ok" }]);
    const secondRoot = join(directory, "second");
    await mkdir(secondRoot);
    await symlink(join(secondRoot, "missing"), join(directory, "redirected"));
    await assert.rejects(ensureRuntimeDir(join(directory, "redirected", "nf"), "."), /Linked or invalid runtime storage/);
    assert.deepEqual(await readdir(secondRoot), []);
  } finally {
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Exercises session reads and atomic creation against linked ancestors, files, and missing targets.
test("rejects redirected session storage without changing the other project's artifacts or events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-session-isolation-"));
  const secondRoot = join(directory, "second");
  const sessionPath = ".forge/runtime/nf/sessions/SESSION-TASK-shared.json";
  const events = [];
  const secondBus = new EventEmitter();
  secondBus.on("file.written", (event) => events.push({ project: "second", ...event }));
  await mkdir(secondRoot);
  const secondFiles = createFileService({ projectRoot: secondRoot, internalBus: secondBus });
  const secondSessions = createSessionStore({ projectId: "PROJECT-second", fileService: secondFiles });
  try {
    await secondSessions.ensureForTask({ task_id: "TASK-shared" });
    const originalContent = await readFile(join(secondRoot, sessionPath), "utf8");
    const originalEntries = (await readdir(secondRoot, { recursive: true })).sort();
    const originalEvents = [...events];
    const redirects = [
      [".forge", ".forge"],
      [".forge/runtime", ".forge/runtime"],
      [".forge/runtime/nf", ".forge/runtime/nf"],
      [".forge/runtime/nf/sessions", ".forge/runtime/nf/sessions"],
      [".forge/runtime/nf/sessions", ".forge/runtime/nf/not-created"],
      [sessionPath, sessionPath]
    ];
    for (const [index, [source, target]] of redirects.entries()) {
      const firstRoot = join(directory, `first-${index}`);
      await mkdir(dirname(join(firstRoot, source)), { recursive: true });
      await symlink(join(secondRoot, target), join(firstRoot, source));
      const firstBus = new EventEmitter();
      firstBus.on("file.written", (event) => events.push({ project: "first", ...event }));
      const firstFiles = createFileService({ projectRoot: firstRoot, internalBus: firstBus, logger: { error: console.error } });
      const firstSessions = createSessionStore({ projectId: "PROJECT-first", fileService: firstFiles });
      await assert.rejects(firstSessions.get("SESSION-TASK-shared"), /Linked paths/);
      await assert.rejects(firstSessions.ensureForTask({ task_id: "TASK-shared" }), /Linked paths/);
      await assert.rejects(firstFiles.atomicCreate({ path: sessionPath, content: "must not be written" }), /Linked paths/);
      await assert.rejects(firstFiles.atomicWrite({ path: sessionPath, content: "must not replace", replace: true }), /Linked paths/);
      if (source !== sessionPath) {
        await assert.rejects(firstSessions.ensureForTask({ task_id: "TASK-new" }), /Linked paths/);
        await assert.rejects(firstFiles.atomicCreate({ path: ".forge/runtime/nf/sessions/SESSION-TASK-new.json", content: "must not be created" }), /Linked paths/);
      }
      assert.deepEqual((await readdir(secondRoot, { recursive: true })).sort(), originalEntries);
      assert.equal(await readFile(join(secondRoot, sessionPath), "utf8"), originalContent);
      assert.deepEqual(events, originalEvents);
      assert.equal((await secondSessions.get("SESSION-TASK-shared")).project_id, "PROJECT-second");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
