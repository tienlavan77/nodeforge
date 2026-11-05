/**
 * Verifies quiet initial loading, retry button removal, and compact quick-entry styling for the
 * Notebook across session state transitions, component markup, and stylesheet declarations.
 * Ensures that unavailable initial list reads (including 503 permission-port errors, missing
 * repositories, or malformed initial payloads) resolve to a normal empty state without displaying
 * unconfirmed-save load alerts, while preserving in-memory drafts, 409 version conflicts, and
 * read-before-retry protection for uncertain mutation writes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createSession } from "../lib/notebook-session.js";

const notebookPanelSource = await readFile(new URL("../components/notebook-panel.jsx", import.meta.url), "utf8");
const notebookStylesSource = await readFile(new URL("../app/styles/notebook-panel.css", import.meta.url), "utf8");

test("unavailable initial Notebook list loads settle into a quiet empty state without error or clearing drafts", async () => {
  const failures = [
    Object.assign(new Error("Notebook project permission port is not configured"), { status: 503 }),
    Object.assign(new Error("Project repository is not available"), { status: 404 }),
    new TypeError("Network request failed"),
  ];
  for (const failure of failures) {
    const session = createSession("quiet-init");
    const editSnapshot = { id: "notebook-existing", project_id: "quiet-init", content: "Existing draft edit", version: 2, status: "open" };
    session.changeDraft({ content: "Draft typed before initial load", edit: editSnapshot });
    const ok = await session.load({
      listNotebook: async () => { throw failure; },
    });
    assert.equal(ok, false);
    const snap = session.getSnapshot();
    assert.equal(snap.loaded, true);
    assert.equal(snap.loading, false);
    assert.deepEqual(snap.items, []);
    assert.equal(snap.error, "");
    assert.equal(snap.uncertain, null);
    assert.equal(snap.conflict, null);
    assert.equal(snap.saved, false);
    assert.equal(snap.draft.content, "Draft typed before initial load");
    assert.deepEqual(snap.draft.edit, editSnapshot);
  }

  const invalidPayloadSession = createSession("quiet-invalid-payload");
  invalidPayloadSession.changeDraft({ content: "Preserved quick draft", edit: null });
  const okInvalid = await invalidPayloadSession.load({
    listNotebook: async () => ({ unexpected: true }),
  });
  assert.equal(okInvalid, false);
  const invalidSnap = invalidPayloadSession.getSnapshot();
  assert.equal(invalidSnap.loaded, true);
  assert.deepEqual(invalidSnap.items, []);
  assert.equal(invalidSnap.error, "");
  assert.equal(invalidSnap.draft.content, "Preserved quick draft");
});

test("quiet initial load suppression does not hide uncertain writes, 409 conflicts, or replay mutations", async () => {
  const session = createSession("quiet-safety");
  const calls = [];
  const item = { id: "notebook-1", project_id: "quiet-safety", content: "Original entry", version: 1, status: "open" };
  let failList = true;
  let failCreate = true;

  const client = {
    listNotebook: async () => {
      calls.push("GET");
      if (failList) {
        throw Object.assign(new Error("Notebook project permission port is not configured"), { status: 503 });
      }
      return [item];
    },
    createNotebook: async ({ content }) => {
      calls.push("POST:" + content);
      if (failCreate === "http") {
        throw Object.assign(new Error("Notebook project permission port is not configured."), { status: 503 });
      }
      if (failCreate) {
        throw Object.assign(new Error("Connection reset during write"), { status: null });
      }
      return { id: "notebook-2", project_id: "quiet-safety", content, version: 1, status: "open" };
    },
    updateNotebook: async ({ id, expected_version }) => {
      calls.push(`PATCH:${id}@${expected_version}`);
      throw Object.assign(new Error("Notebook version conflict"), { status: 409 });
    },
    getNotebook: async () => ({ ...item, content: "Server updated content", version: 4 }),
  };

  await session.load(client);
  assert.equal(session.getSnapshot().error, "");
  assert.equal(session.getSnapshot().loaded, true);

  session.changeDraft({ content: "Important new entry", edit: { ...item, content: "Local edit v1" } });
  failCreate = "http";
  assert.equal(await session.mutate(client, "create"), false);
  assert.equal(session.getSnapshot().error, "Notebook project permission port is not configured.");
  assert.equal(session.getSnapshot().uncertain, null);
  assert.equal(session.getSnapshot().draft.content, "Important new entry");

  // Definite HTTP failure does not require reconciliation GET before the next explicit retry.
  failCreate = true;
  assert.equal(await session.mutate(client, "create"), false);
  assert.deepEqual(calls, ["GET", "POST:Important new entry", "POST:Important new entry"]);
  assert.match(session.getSnapshot().error, /Chưa xác nhận lưu/);
  assert.equal(session.getSnapshot().uncertain?.kind, "create");
  assert.equal(session.getSnapshot().uncertain?.checked, false);
  assert.equal(session.getSnapshot().draft.content, "Important new entry");

  // Retry while listNotebook still fails must keep the unconfirmed-save error visible and never replay POST.
  assert.equal(await session.mutate(client, "create"), false);
  assert.deepEqual(calls, ["GET", "POST:Important new entry", "POST:Important new entry", "GET"]);
  assert.match(session.getSnapshot().error, /Chưa xác nhận lưu\. Không thể tải dữ liệu/);
  assert.equal(session.getSnapshot().uncertain?.checked, false);

  // Once listNotebook recovers, first retry performs reconciliation read only without replaying POST.
  failList = false;
  failCreate = false;
  assert.equal(await session.mutate(client, "create"), false);
  assert.deepEqual(calls, ["GET", "POST:Important new entry", "POST:Important new entry", "GET", "GET"]);
  assert.equal(session.getSnapshot().uncertain?.checked, true);
  assert.equal(session.getSnapshot().error, "");

  // 409 conflict on edit preserves local edit and version 1 while allowing server comparison.
  const editDraft = session.getSnapshot().draft.edit;
  assert.equal(await session.mutate(client, "edit", editDraft), false);
  assert.match(session.getSnapshot().error, /Xung đột phiên bản/);
  assert.equal(session.getSnapshot().conflict?.id, "notebook-1");
  assert.equal(session.getSnapshot().draft.edit.version, 1);
  assert.equal(session.getSnapshot().draft.edit.content, "Local edit v1");

  await session.compare(client);
  assert.equal(session.getSnapshot().comparison?.content, "Server updated content");
  assert.equal(session.getSnapshot().comparison?.version, 4);
  assert.equal(session.getSnapshot().draft.edit.version, 1);
});

test("concurrent create acknowledged while initial read is pending remains preserved when initial read rejects quietly", async () => {
  const session = createSession("quiet-concurrent-create");
  let rejectRead;
  const createdItem = {
    id: "notebook-created-1",
    project_id: "quiet-concurrent-create",
    content: "Created while initial list was still pending",
    version: 1,
    status: "open",
  };
  const client = {
    listNotebook: () => new Promise((_, reject) => {
      rejectRead = reject;
    }),
    createNotebook: async ({ content }) => ({ ...createdItem, content }),
  };

  const loadPromise = session.load(client);
  session.changeDraft({ content: createdItem.content, edit: null });
  assert.equal(await session.mutate(client, "create"), true);
  assert.deepEqual(session.getSnapshot().items, [createdItem]);
  assert.equal(session.getSnapshot().saved, true);

  rejectRead(Object.assign(new Error("Notebook project permission port is not configured"), { status: 503 }));
  assert.equal(await loadPromise, false);

  const snap = session.getSnapshot();
  assert.deepEqual(snap.items, [createdItem]);
  assert.equal(snap.loaded, true);
  assert.equal(snap.loading, false);
  assert.equal(snap.error, "");
  assert.equal(snap.saved, true);
  assert.equal(snap.draft.content, "");
});

test("NotebookPanel removes the error retry button and aligns the quick-entry submit button to the bottom right with fit-content width", () => {
  assert.doesNotMatch(notebookPanelSource, />\s*Thử lại\s*</);
  assert.match(notebookPanelSource, /Tải bản server để đối chiếu/);
  assert.match(notebookPanelSource, /<button\b(?=[^>]*\btype=["']submit["'])[^>]*>\s*Thêm (?:sổ tay|ghi chú)\s*<\/button>/);
  assert.match(notebookStylesSource, /align-self:\s*flex-end/);
  assert.match(notebookStylesSource, /width:\s*fit-content/);
});

test("reorder mutation sends position and optional status while updating session item order", async () => {
  const session = createSession("reorder-proj");
  const calls = [];
  const items = [
    { id: "i1", project_id: "reorder-proj", content: "First", status: "open", position: 0, version: 1 },
    { id: "i2", project_id: "reorder-proj", content: "Second", status: "open", position: 1, version: 1 },
    { id: "i3", project_id: "reorder-proj", content: "Third", status: "open", position: 2, version: 1 }
  ];
  const client = {
    listNotebook: async () => items,
    updateNotebook: async (opts) => {
      calls.push(opts);
      const found = items.find(entry => entry.id === opts.id);
      return { ...found, ...opts, version: found.version + 1 };
    }
  };
  await session.load(client);
  assert.equal(await session.mutate(client, "reorder", { ...items[2], position: 0, status: "done" }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "i3");
  assert.equal(calls[0].position, 0);
  assert.equal(calls[0].status, "done");
  assert.equal(calls[0].expected_version, 1);
  assert.deepEqual(session.getSnapshot().items.map(i => ({ id: i.id, position: i.position, status: i.status })), [
    { id: "i3", position: 0, status: "done" },
    { id: "i1", position: 1, status: "open" },
    { id: "i2", position: 2, status: "open" }
  ]);
});

test("create mutation places newly added note at the top of the notebook list", async () => {
  const session = createSession("prepend-proj");
  const existing = [
    { id: "n1", project_id: "prepend-proj", content: "Older note 1", status: "open", position: 0, version: 1 },
    { id: "n2", project_id: "prepend-proj", content: "Older note 2", status: "open", position: 1, version: 1 }
  ];
  const client = {
    listNotebook: async () => existing,
    createNotebook: async ({ content }) => ({
      id: "n3",
      project_id: "prepend-proj",
      content,
      status: "open",
      position: 0,
      version: 1
    })
  };
  await session.load(client);
  session.changeDraft({ content: "Newest note at top", edit: null });
  assert.equal(await session.mutate(client, "create"), true);
  assert.deepEqual(
    session.getSnapshot().items.map((item) => ({ id: item.id, content: item.content, position: item.position })),
    [
      { id: "n3", content: "Newest note at top", position: 0 },
      { id: "n1", content: "Older note 1", position: 1 },
      { id: "n2", content: "Older note 2", position: 2 }
    ]
  );
});
