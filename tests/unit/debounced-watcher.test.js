import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDebouncedWatcher, createNodeEventValidator } from "../../src/modules/watcher/debounced-watcher.js";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("coalesces five consecutive file changes into one schema-valid watcher event", async () => {
  const rawWatcher = new EventEmitter();
  const watcher = createDebouncedWatcher({
    rawWatcher,
    projectId: "PROJECT-001",
    root: "/project",
    debounceMs: 100,
    createEventId: () => "EVT-WATCHER-001"
  });
  const events = [];
  watcher.on("event", (event) => events.push(event));

  for (let count = 0; count < 5; count += 1) rawWatcher.emit("change", "/project/src/session.js");
  await wait(150);

  assert.deepEqual(events, [{
    event_id: "EVT-WATCHER-001",
    type: "watcher.file_modified",
    project_id: "PROJECT-001",
    timestamp: events[0].timestamp,
    payload: { path: "src/session.js", operation: "change" }
  }]);
  assert.equal(createNodeEventValidator()(events[0]), true);
  watcher.close();
});

test("merges an unlink and same-content add into one file renamed event", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-rename-"));
  const oldPath = join(root, "src", "auth.js");
  const newPath = join(root, "src", "security", "auth.js");
  const rawWatcher = new EventEmitter();
  let watcher;

  try {
    await mkdir(join(root, "src", "security"), { recursive: true });
    await writeFile(oldPath, "export const auth = true;\n");
    watcher = createDebouncedWatcher({ rawWatcher, projectId: "PROJECT-001", root, debounceMs: 100, renameWindowMs: 300 });
    const events = [];
    watcher.on("event", (event) => events.push(event));

    rawWatcher.emit("add", oldPath);
    await wait(150);
    events.length = 0;

    await rename(oldPath, newPath);
    rawWatcher.emit("unlink", oldPath);
    rawWatcher.emit("add", newPath);
    await wait(150);

    assert.deepEqual(events.map(({ type, payload }) => ({ type, payload })), [{
      type: "watcher.file_renamed",
      payload: { path: "src/security/auth.js", old_path: "src/auth.js", operation: "rename" }
    }]);
  } finally {
    watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("merges a same-content add followed by unlink into one file renamed event", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-rename-reversed-"));
  const oldPath = join(root, "src", "auth.js");
  const newPath = join(root, "src", "security", "auth.js");
  const rawWatcher = new EventEmitter();
  let watcher;

  try {
    await mkdir(join(root, "src", "security"), { recursive: true });
    await writeFile(oldPath, "export const auth = true;\n");
    watcher = createDebouncedWatcher({ rawWatcher, projectId: "PROJECT-001", root, debounceMs: 100, renameWindowMs: 300 });
    const events = [];
    watcher.on("event", (event) => events.push(event));

    rawWatcher.emit("change", oldPath);
    await wait(150);
    events.length = 0;

    await rename(oldPath, newPath);
    rawWatcher.emit("add", newPath);
    rawWatcher.emit("unlink", oldPath);
    await wait(150);

    assert.deepEqual(events.map(({ type, payload }) => ({ type, payload })), [{
      type: "watcher.file_renamed",
      payload: { path: "src/security/auth.js", old_path: "src/auth.js", operation: "rename" }
    }]);
  } finally {
    watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("does not merge a move when the file content changes", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-rename-"));
  const oldPath = join(root, "src", "auth.js");
  const newPath = join(root, "src", "security", "auth.js");
  const rawWatcher = new EventEmitter();
  let watcher;

  try {
    await mkdir(join(root, "src", "security"), { recursive: true });
    await writeFile(oldPath, "export const auth = true;\n");
    watcher = createDebouncedWatcher({ rawWatcher, projectId: "PROJECT-001", root, debounceMs: 100, renameWindowMs: 300 });
    const events = [];
    watcher.on("event", (event) => events.push(event));

    rawWatcher.emit("add", oldPath);
    await wait(150);
    events.length = 0;

    await rename(oldPath, newPath);
    await writeFile(newPath, "export const auth = false;\n");
    rawWatcher.emit("unlink", oldPath);
    rawWatcher.emit("add", newPath);
    await wait(450);

    assert.deepEqual(events.map(({ type }) => type).sort(), ["watcher.file_created", "watcher.file_deleted"]);
  } finally {
    watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});
