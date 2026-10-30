/**
 * Verifies quiet initial loading, retry button removal, and compact quick-entry styling for the
 * Ideas notebook across session state transitions, component markup, and stylesheet declarations.
 * Ensures that unavailable initial list reads (including 503 permission-port errors, missing
 * repositories, or malformed initial payloads) resolve to a normal empty state without displaying
 * unconfirmed-save load alerts, while preserving in-memory drafts, 409 version conflicts, and
 * read-before-retry protection for uncertain mutation writes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createSession } from "../lib/ideas-session.js";

const ideasPanelSource = await readFile(new URL("../components/ideas-panel.jsx", import.meta.url), "utf8");
const ideasStylesSource = await readFile(new URL("../app/styles/ideas-panel.css", import.meta.url), "utf8");

test("unavailable initial Ideas list loads settle into a quiet empty state without error or clearing drafts", async () => {
  const failures = [
    Object.assign(new Error("Ideas project permission port is not configured"), { status: 503 }),
    Object.assign(new Error("Project repository is not available"), { status: 404 }),
    new TypeError("Network request failed"),
  ];

  for (const failure of failures) {
    const session = createSession("quiet-init");
    const editSnapshot = { id: "idea-existing", project_id: "quiet-init", content: "Existing draft edit", version: 2, status: "open" };
    session.changeDraft({ content: "Draft typed before initial load", edit: editSnapshot });

    const ok = await session.load({
      listIdeas: async () => { throw failure; },
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
    listIdeas: async () => ({ unexpected: true }),
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
  const item = { id: "idea-1", project_id: "quiet-safety", content: "Original idea", version: 1, status: "open" };
  let failList = true;
  let failCreate = true;

  const client = {
    listIdeas: async () => {
      calls.push("GET");
      if (failList) {
        throw Object.assign(new Error("Ideas project permission port is not configured"), { status: 503 });
      }
      return [item];
    },
    createIdea: async ({ content }) => {
      calls.push("POST:" + content);
      if (failCreate) {
        throw Object.assign(new Error("Connection reset during write"), { status: 503 });
      }
      return { id: "idea-2", project_id: "quiet-safety", content, version: 1, status: "open" };
    },
    updateIdea: async ({ id, expected_version }) => {
      calls.push(`PATCH:${id}@${expected_version}`);
      throw Object.assign(new Error("Idea version conflict"), { status: 409 });
    },
    getIdea: async () => ({ ...item, content: "Server updated content", version: 4 }),
  };

  await session.load(client);
  assert.equal(session.getSnapshot().error, "");
  assert.equal(session.getSnapshot().loaded, true);

  session.changeDraft({ content: "Important new idea", edit: { ...item, content: "Local edit v1" } });
  assert.equal(await session.mutate(client, "create"), false);
  assert.match(session.getSnapshot().error, /Chưa xác nhận lưu/);
  assert.equal(session.getSnapshot().uncertain?.kind, "create");
  assert.equal(session.getSnapshot().uncertain?.checked, false);
  assert.equal(session.getSnapshot().draft.content, "Important new idea");

  // Retry while listIdeas still fails must keep the unconfirmed-save error visible and never replay POST.
  assert.equal(await session.mutate(client, "create"), false);
  assert.deepEqual(calls, ["GET", "POST:Important new idea", "GET"]);
  assert.match(session.getSnapshot().error, /Chưa xác nhận lưu\. Không thể tải dữ liệu/);
  assert.equal(session.getSnapshot().uncertain?.checked, false);

  // Once listIdeas recovers, first retry performs reconciliation read only without replaying POST.
  failList = false;
  failCreate = false;
  assert.equal(await session.mutate(client, "create"), false);
  assert.deepEqual(calls, ["GET", "POST:Important new idea", "GET", "GET"]);
  assert.equal(session.getSnapshot().uncertain?.checked, true);
  assert.equal(session.getSnapshot().error, "");

  // 409 conflict on edit preserves local edit and version 1 while allowing server comparison.
  const editDraft = session.getSnapshot().draft.edit;
  assert.equal(await session.mutate(client, "edit", editDraft), false);
  assert.match(session.getSnapshot().error, /Xung đột phiên bản/);
  assert.equal(session.getSnapshot().conflict?.id, "idea-1");
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
    id: "idea-created-1",
    project_id: "quiet-concurrent-create",
    content: "Created while initial list was still pending",
    version: 1,
    status: "open",
  };

  const client = {
    listIdeas: () => new Promise((_, reject) => {
      rejectRead = reject;
    }),
    createIdea: async ({ content }) => ({ ...createdItem, content }),
  };

  const loadPromise = session.load(client);
  session.changeDraft({ content: createdItem.content, edit: null });
  assert.equal(await session.mutate(client, "create"), true);
  assert.deepEqual(session.getSnapshot().items, [createdItem]);
  assert.equal(session.getSnapshot().saved, true);

  rejectRead(Object.assign(new Error("Ideas project permission port is not configured"), { status: 503 }));
  assert.equal(await loadPromise, false);

  const snap = session.getSnapshot();
  assert.deepEqual(snap.items, [createdItem]);
  assert.equal(snap.loaded, true);
  assert.equal(snap.loading, false);
  assert.equal(snap.error, "");
  assert.equal(snap.saved, true);
  assert.equal(snap.draft.content, "");
});

test("IdeasPanel removes the error retry button and aligns the quick-entry submit button to the bottom right with fit-content width", () => {
  assert.doesNotMatch(ideasPanelSource, />\s*Thử lại\s*</);
  assert.match(ideasPanelSource, /Tải bản server để đối chiếu/);
  assert.match(ideasPanelSource, /<button\b(?=[^>]*\btype=["']submit["'])[^>]*>\s*Thêm ý tưởng\s*<\/button>/);
  assert.match(ideasStylesSource, /align-self:\s*flex-end/);
  assert.match(ideasStylesSource, /width:\s*fit-content/);
});
