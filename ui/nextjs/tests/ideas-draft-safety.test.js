/**
 * Exercises notebook safety through the production session store and project-bound client.
 * Deferred transport responses model overlapping edits, obsolete selections, and lost
 * acknowledgements without touching live APIs. Privacy probes capture writes and logs
 * while real draft transitions run; no user content needs durable browser storage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createSession, getIdeasSession } from "../lib/ideas-session.js";
import { bindProjectClient, refreshProjects, selectProject } from "../lib/project-selection.js";

/** Hold a transport completion until the test has changed input or project identity. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/** Supply deterministic records and count each attempted write and authoritative read. */
function fixture() {
  const calls = [];
  const item = { id: "idea-a", project_id: "A", content: "original", version: 1, status: "open" };
  const client = {
    listIdeas: async (options) => { calls.push(["GET", options]); return [{ ...item }]; },
    getIdea: async (options) => { calls.push(["GET item", options]); return { ...item }; },
    createIdea: async (options) => { calls.push(["POST", options]); return { ...item, ...options }; },
    updateIdea: async (options) => { calls.push(["PATCH", options]); return { ...item, ...options, version: 2 }; },
    deleteIdea: async (options) => { calls.push(["DELETE", options]); return { deleted: true }; }
  };
  return { calls, item, client };
}

test("project sessions retain independent edits and original versions across subscribers", () => {
  const a = getIdeasSession("unit-project-a"), b = getIdeasSession("unit-project-b");
  const { item } = fixture();
  a.changeDraft({ content: "A quick", edit: { ...item, content: "A edit" } });
  b.changeDraft({ content: "B quick", edit: null });
  let updates = 0;
  const unsubscribe = a.subscribe(() => updates++);
  a.changeDraft({ ...a.getSnapshot().draft, content: "A later" });
  unsubscribe();
  assert.equal(updates, 1);
  assert.equal(getIdeasSession("unit-project-a").getSnapshot().draft.edit.version, 1);
  assert.equal(getIdeasSession("unit-project-a").getSnapshot().draft.edit.id, item.id);
  assert.equal(b.getSnapshot().draft.content, "B quick");
});

test("create and edit success acknowledge snapshots while preserving all later replacements", async () => {
  for (const kind of ["create", "edit"]) {
    const session = createSession("A"), { client, item } = fixture(), pending = deferred();
    await session.load(client);
    session.changeDraft({ content: "submitted", edit: { ...item, content: "submitted edit" } });
    client[kind === "create" ? "createIdea" : "updateIdea"] = () => pending.promise;
    const submitted = session.getSnapshot().draft.edit;
    const operation = session.mutate(client, kind, submitted);
    const later = { content: "later quick", edit: { ...submitted, content: "later edit" } };
    session.changeDraft(later);
    assert.equal(await session.mutate(client, kind, submitted), false);
    pending.resolve({ ...item, version: 2 });
    assert.equal(await operation, true);
    assert.equal(session.getSnapshot().draft, later);
    assert.equal(session.getSnapshot().draft.edit.version, 1);
    assert.equal(session.getSnapshot().saved, true);
  }
});

test("409 comparison never changes the draft version or retries a mutation", async () => {
  const session = createSession("A"), { calls, client, item } = fixture();
  await session.load(client);
  const edit = { ...item, content: "my complete edit" };
  session.changeDraft({ content: "quick", edit });
  client.updateIdea = async (options) => {
    calls.push(["PATCH", options]); throw Object.assign(new Error("conflict"), { status: 409 });
  };
  await session.mutate(client, "edit", edit);
  client.getIdea = async () => ({ ...item, content: "server changes", version: 8 });
  await session.compare(client);
  await session.load(client);
  assert.equal(session.getSnapshot().draft.edit, edit);
  assert.equal(session.getSnapshot().comparison.version, 8);
  assert.match(session.getSnapshot().error, /Xung đột/);
  assert.equal(calls.filter(([method]) => method === "PATCH").length, 1);
  assert.equal(calls.find(([method]) => method === "PATCH")[1].expected_version, 1);
  await session.mutate(client, "edit", edit);
  assert.deepEqual(calls.filter(([method]) => method === "PATCH").map(([, options]) => options.expected_version), [1, 1]);
  assert.equal(session.getSnapshot().draft.edit, edit);
});

test("all failed writes require a read before another explicit write and never replay", async () => {
  for (const kind of ["create", "edit", "toggle", "delete"]) {
    for (const status of [null, 503, 404]) {
      const session = createSession("A"), { calls, client, item } = fixture();
      const method = kind === "create" ? "createIdea" : kind === "delete" ? "deleteIdea" : "updateIdea";
      session.changeDraft({ content: "private draft", edit: item });
      client[method] = async () => { calls.push(["WRITE"]); throw Object.assign(new Error("unavailable"), { status }); };
      await session.mutate(client, kind, item);
      const draft = session.getSnapshot().draft;
      assert.match(session.getSnapshot().error, /Chưa xác nhận lưu/);
      assert.equal(await session.mutate(client, kind, item), false);
      assert.deepEqual(calls.map(([method]) => method), ["WRITE", "GET"]);
      assert.equal(session.getSnapshot().draft, draft);
      assert.equal(session.getSnapshot().uncertain.checked, true);
      await session.mutate(client, kind, item);
      assert.equal(calls.filter(([method]) => method === "WRITE").length, 2);
      assert.equal(session.getSnapshot().uncertain.checked, false);
    }
  }
});

test("failed reconciliation and absent records preserve uncertain input without writes", async () => {
  const session = createSession("A"), { client, item } = fixture();
  session.changeDraft({ content: "unresolved create", edit: item });
  client.createIdea = async () => { throw new Error("response lost after commit"); };
  await session.mutate(client, "create");
  client.listIdeas = async () => { throw new Error("still offline"); };
  await session.mutate(client, "create");
  await session.mutate(client, "create");
  assert.equal(session.getSnapshot().uncertain.checked, false);
  client.listIdeas = async () => null;
  await session.mutate(client, "create");
  assert.equal(session.getSnapshot().uncertain.checked, false);
  client.listIdeas = async () => [];
  await session.load(client);
  assert.equal(session.getSnapshot().uncertain.kind, "create");
  assert.equal(session.getSnapshot().draft.content, "unresolved create");
  assert.equal(session.getSnapshot().draft.edit.id, item.id);
});

test("reads completing before a confirmed write cannot replace its newer collection", async () => {
  const session = createSession("A"), { client, item } = fixture();
  await session.load(client);
  const write = deferred(), staleRead = deferred();
  client.updateIdea = () => write.promise;
  const mutation = session.mutate(client, "edit", item);
  let reads = 0;
  client.listIdeas = () => ++reads === 1 ? staleRead.promise : Promise.resolve([{ ...item, content: "confirmed", version: 2 }]);
  const reload = session.load(client);
  write.resolve({ ...item, content: "confirmed", version: 2 });
  await mutation;
  staleRead.resolve([item]);
  await reload;
  assert.equal(reads, 2);
  assert.equal(session.getSnapshot().items[0].content, "confirmed");
});

test("a read started before a lost response cannot satisfy read-before-retry reconciliation", async () => {
  const session = createSession("A"), { client, item } = fixture();
  const write = deferred(), read = deferred();
  session.changeDraft({ content: "private pending", edit: item });
  client.createIdea = () => write.promise;
  client.listIdeas = () => read.promise;
  const mutation = session.mutate(client, "create"), loading = session.load(client);
  write.reject(new Error("lost after commit"));
  await mutation;
  read.resolve([item]); await loading;
  assert.equal(session.getSnapshot().uncertain.checked, false);
  assert.match(session.getSnapshot().error, /Cần tải lại/);
});

test("stale selection generations reject late reads and writes without touching project B", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ projects: [{ project_id: "A" }, { project_id: "B" }] });
    await refreshProjects({ selectInitial: false }); selectProject("A");
    const { client, item } = fixture(), pendingRead = deferred(), pendingWrite = deferred();
    client.listIdeas = () => pendingRead.promise;
    client.updateIdea = () => pendingWrite.promise;
    const bound = bindProjectClient(client);
    const a = createSession("A"), b = createSession("B");
    a.changeDraft({ content: "A", edit: item }); b.changeDraft({ content: "B", edit: null });
    const mutation = a.mutate(bound, "edit", item);
    const read = a.load(bound);
    selectProject("B"); selectProject("A");
    pendingRead.resolve([item]); pendingWrite.resolve({ ...item, version: 2 });
    await mutation; await read;
    assert.equal(a.getSnapshot().draft.edit.version, 1);
    assert.equal(a.getSnapshot().saved, false);
    assert.equal(a.getSnapshot().uncertain.checked, false);
    assert.equal(b.getSnapshot().draft.content, "B");
    assert.deepEqual(b.getSnapshot().items, []);
  } finally { globalThis.fetch = previousFetch; }
});

test("drafts and failures neither log Idea content nor write browser storage", async () => {
  const logs = [], writes = [];
  const previousConsole = { ...console }, previousWindow = globalThis.window;
  try {
    for (const method of ["log", "warn", "error", "info", "debug"]) console[method] = (...args) => logs.push(args);
    globalThis.window = { localStorage: { setItem: (...args) => writes.push(args) },
      sessionStorage: { setItem: (...args) => writes.push(args) } };
    const session = createSession("privacy"), { client, item } = fixture();
    session.changeDraft({ content: "private Idea with credential-like text", edit: item });
    client.createIdea = async () => { throw new Error("private server response"); };
    await session.mutate(client, "create"); await session.load(client);
    assert.deepEqual(logs, []); assert.deepEqual(writes, []);
  } finally {
    Object.assign(console, previousConsole);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
