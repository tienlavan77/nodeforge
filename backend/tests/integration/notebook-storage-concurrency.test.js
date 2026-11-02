// Verifies optimistic notebook writes through independent SQLite connections.
// Competing clients must observe a conflict without changing the winning revision.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createNotebookStore } from "../../src/modules/projects/notebook-store.js";

test("independent threads racing the same version produce one winner and one conflict", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "notebook-threads-"));
  const workers = [];
  let db;
  try {
    db = await openIndexDatabase(root, { storageKind: "control" });
    const store = createNotebookStore({ controlDb: db, projectId: "a" });
    const entry = store.create({ content: "initial" });
    const ready = [];
    for (const content of ["first", "second"]) {
      const worker = new Worker(new URL("./notebook-storage-worker.js", import.meta.url), {
        workerData: { root, id: entry.id, content, operation: "update" }
      });
      workers.push(worker);
      ready.push(once(worker, "message"));
    }
    for (const [message] of await Promise.all(ready)) assert.equal(message.ready, true);
    const completed = workers.map(worker => once(worker, "message"));
    for (const worker of workers) worker.postMessage("go");
    const results = (await Promise.all(completed)).map(([message]) => message);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const winner = results.find(result => result.status === 200).result;
    assert.equal(winner.version, 2);
    assert.deepEqual(store.get(entry.id), winner);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    await db?.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Releases both worker contenders simultaneously after their independent SQLite connections are ready.
// Verifies that concurrent PATCH/DELETE and DELETE/DELETE races yield one winner and one 409 conflict.
for (const operation of ["delete", "update"]) {
  test(`independent threads racing DELETE and ${operation} produce one winner and one conflict`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "notebook-concurrent-delete-"));
    const workers = [];
    let db;
    try {
      db = await openIndexDatabase(root, { storageKind: "control" });
      const store = createNotebookStore({ controlDb: db, projectId: "a" });
      const entry = store.create({ content: "initial" });
      const ready = [];
      for (const contender of ["delete", operation]) {
        const worker = new Worker(new URL("./notebook-storage-worker.js", import.meta.url), {
          workerData: { root, id: entry.id, operation: contender, content: "updated" }
        });
        workers.push(worker);
        ready.push(once(worker, "message"));
      }
      for (const [message] of await Promise.all(ready)) assert.equal(message.ready, true);
      const completed = workers.map(worker => once(worker, "message"));
      for (const worker of workers) worker.postMessage("go");
      const results = (await Promise.all(completed)).map(([message]) => message);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      const winner = results.find(result => result.status === 200).result;
      if (winner === true) {
        assert.equal(store.get(entry.id), undefined);
      } else {
        assert.equal(winner.version, 2);
        assert.equal(winner.content, "updated");
        assert.deepEqual(store.get(entry.id), winner);
      }
    } finally {
      await Promise.all(workers.map(worker => worker.terminate()));
      await db?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

// Coordinates already-connected contenders so deletion commits before each stale write.
// Reopening the database also verifies that conflict history survives backend restarts.
for (const operation of ["delete", "update"]) {
  test(`DELETE winning against ${operation} preserves a durable project-scoped conflict`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "notebook-delete-race-"));
    const workers = [];
    let db;
    try {
      db = await openIndexDatabase(root, { storageKind: "control" });
      const store = createNotebookStore({ controlDb: db, projectId: "a" });
      const entry = store.create({ content: "delete winner" });
      const untouched = store.create({ content: "keep" });
      const ready = [];
      for (const contender of ["delete", operation]) {
        const worker = new Worker(new URL("./notebook-storage-worker.js", import.meta.url), {
          workerData: { root, id: entry.id, operation: contender, content: "stale" }
        });
        workers.push(worker);
        ready.push(once(worker, "message"));
      }
      for (const [message] of await Promise.all(ready)) assert.equal(message.ready, true);
      const winner = once(workers[0], "message");
      workers[0].postMessage("go");
      assert.deepEqual((await winner)[0], { status: 200, result: true });
      const loser = once(workers[1], "message");
      workers[1].postMessage("go");
      assert.equal((await loser)[0].status, 409);
      assert.equal(store.get(entry.id), undefined);
      assert.deepEqual(store.list(), [untouched]);
      await db.close();
      db = await openIndexDatabase(root, { storageKind: "control" });
      const reopened = createNotebookStore({ controlDb: db, projectId: "a" });
      assert.throws(() => reopened.update(entry.id, { version: 1, content: "stale" }), { status: 409 });
      assert.throws(() => reopened.delete(entry.id, { version: 1 }), { status: 409 });
      assert.throws(() => reopened.delete("never-created", { version: 1 }), { status: 404 });
      const other = createNotebookStore({ controlDb: db, projectId: "b" });
      assert.throws(() => other.delete(entry.id, { version: 1 }), { status: 404 });
      assert.deepEqual(reopened.list(), [untouched]);
    } finally {
      await Promise.all(workers.map(worker => worker.terminate()));
      await db?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("two clients cannot update or delete the same saved revision twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "notebook-race-"));
  let first;
  let second;
  try {
    first = await openIndexDatabase(root, { storageKind: "control" });
    second = await openIndexDatabase(root, { storageKind: "control" });
    const a = createNotebookStore({ controlDb: first, projectId: "a" });
    const b = createNotebookStore({ controlDb: second, projectId: "a" });
    const other = createNotebookStore({ controlDb: second, projectId: "b" });
    const entry = a.create({ content: "original" });
    assert.equal(other.get(entry.id), undefined);
    assert.throws(() => other.update(entry.id, { version: 1, content: "cross project" }), { status: 404 });
    assert.throws(() => other.delete(entry.id, { version: 1 }), { status: 404 });
    const results = await Promise.allSettled([
      Promise.resolve().then(() => a.update(entry.id, { version: 1, content: "winner", status: "done" })),
      Promise.resolve().then(() => b.update(entry.id, { version: 1, content: "loser" }))
    ]);
    assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
    assert.equal(results.find(row => row.status === "rejected").reason.status, 409);
    assert.deepEqual(b.get(entry.id), { ...entry, content: "winner", status: "done", version: 2, updated_at: b.get(entry.id).updated_at });
    assert.throws(() => b.delete(entry.id, { version: 1 }), { status: 409 });
    assert.equal(a.list({ status: "done" }).length, 1);
    assert.equal(other.list().length, 0);
    assert.equal(a.list({ status: "open" }).length, 0);
    assert.equal(b.delete(entry.id, { version: 2 }), true);
    assert.throws(() => a.delete(entry.id, { version: 2 }), { status: 409 });
    const next = a.create({ content: "delete contender" });
    const mixed = await Promise.allSettled([
      Promise.resolve().then(() => b.update(next.id, { version: 1, content: "changed" })),
      Promise.resolve().then(() => a.delete(next.id, { version: 1 }))
    ]);
    assert.equal(mixed.filter(row => row.status === "fulfilled").length, 1);
    assert.equal(mixed.find(row => row.status === "rejected").reason.status, 409);
    assert.equal(a.get(next.id).version, 2);
    assert.equal(a.get(next.id).content, "changed");
  } finally {
    await first?.close();
    await second?.close();
    await rm(root, { recursive: true, force: true });
  }
});
