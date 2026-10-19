// Verifies filesystem failures are reported without crashing the watcher or blocking subsequent project events.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import chokidar from "chokidar";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Supplies real project files so recovery tests exercise the filesystem admission boundary.
async function projectRoot(context) {
  const root = await mkdtemp(join(tmpdir(), "forge-watcher-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["denied.js", "valid.js", "old.js", "new.js", "invalid.js"]) await writeFile(join(root, path), "source");
  return root;
}
import { createDebouncedWatcher } from "../../src/modules/watcher/debounced-watcher.js";
import { createFilesystemWatcher } from "../../src/infrastructure/filesystem/watcher.js";

// Bounds recovery assertions so a missing watcher notification fails instead of hanging the test.
function nextEvent(watcher, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watcher.off(type, listener); reject(new Error(`Missing ${type}`)); }, 2000);
    const listener = (event) => { clearTimeout(timer); watcher.off(type, listener); resolve(event); };
    watcher.on(type, listener);
  });
}

test("content read rejection reports an error and the next file is still indexed", async (context) => {
  const root = await projectRoot(context);
  const rawWatcher = new EventEmitter();
  const denied = Object.assign(new Error("Cannot read project file"), { code: "EACCES" });
  const watcher = createDebouncedWatcher({ rawWatcher, projectId: "PROJECT-1", root, debounceMs: 100,
    getContentHash: async (path) => { if (path.endsWith("denied.js")) throw denied; return "hash"; } });
  context.after(() => watcher.close());
  const error = nextEvent(watcher, "watcher.error");
  rawWatcher.emit("change", `${root}/denied.js`);
  assert.equal(await error, denied);
  const next = nextEvent(watcher, "event");
  rawWatcher.emit("change", `${root}/valid.js`);
  assert.equal((await next).payload.path, "valid.js");
});

test("raw watcher errors are forwarded and the listener is removed on shutdown", (context) => {
  const rawWatcher = new EventEmitter();
  const watcher = createDebouncedWatcher({ rawWatcher, projectId: "PROJECT-1", root: process.cwd() });
  context.after(() => watcher.close());
  const errors = [];
  watcher.on("watcher.error", (error) => errors.push(error));
  const failure = new Error("watch resource unavailable");
  rawWatcher.emit("error", failure);
  assert.deepEqual(errors, [failure]);
  watcher.close();
  assert.equal(rawWatcher.listenerCount("error"), 0);
});

test("chokidar resource failures reach the runtime error handler rather than an unhandled error event", (context) => {
  const source = new EventEmitter();
  source.close = () => undefined;
  context.mock.method(chokidar, "watch", () => source);
  const rawWatcher = createFilesystemWatcher({ root: process.cwd() });
  const watcher = createDebouncedWatcher({ rawWatcher, projectId: "PROJECT-1", root: process.cwd() });
  context.after(() => watcher.close());
  const errors = [];
  watcher.on("watcher.error", (error) => errors.push(error));
  const failure = Object.assign(new Error("watch limit reached"), { code: "ENOSPC" });
  source.emit("error", failure);
  assert.deepEqual(errors, [failure]);
});

test("rename detection still emits one event after recovery changes", async (context) => {
  const root = await projectRoot(context);
  const rawWatcher = new EventEmitter();
  const watcher = createDebouncedWatcher({ rawWatcher, projectId: "PROJECT-1", root, debounceMs: 100, renameWindowMs: 150, getContentHash: async () => "same-hash" });
  context.after(() => watcher.close());
  const baseline = nextEvent(watcher, "event");
  rawWatcher.emit("add", `${root}/old.js`);
  await baseline;
  const renamed = nextEvent(watcher, "event");
  rawWatcher.emit("unlink", `${root}/old.js`);
  rawWatcher.emit("add", `${root}/new.js`);
  const event = await renamed;
  assert.equal(event.type, "watcher.file_renamed");
  assert.deepEqual(event.payload, { path: "new.js", operation: "rename", old_path: "old.js" });
});

test("invalid delayed rename events are reported instead of throwing from a timer", async (context) => {
  const root = await projectRoot(context);
  const rawWatcher = new EventEmitter();
  const failure = new Error("Invalid event path");
  const watcher = createDebouncedWatcher({ rawWatcher, projectId: "PROJECT-1", root, debounceMs: 100, renameWindowMs: 100,
    getContentHash: async () => "hash", validateEvent: () => { throw failure; } });
  context.after(() => watcher.close());
  const error = nextEvent(watcher, "watcher.error");
  rawWatcher.emit("add", `${root}/invalid.js`);
  assert.equal(await error, failure);
});
