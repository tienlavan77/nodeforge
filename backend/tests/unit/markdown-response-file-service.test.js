// Verifies Markdown response exports remain project-scoped, typed, and overwrite-safe.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createMarkdownResponseFileService } from "../../src/application/markdown-response-file-service.js";
import { createForgeV1ConversationRoutes } from "../../src/transport/http/forge-v1-conversation-routes.js";

// Creates a minimal stored assistant reply for an export authorization case.
function createFixture(root, overrides = {}) {
  const message = { id: "MSG-1", project_id: "PROJECT-A", conversation_id: "CONV-A", sender: { role: "architecture_manager" }, message_type: "architecture.message.received", payload: { text: "# Hello\n", content_type: "text/markdown" }, ...overrides };
  const conversations = { get: (id) => id === "CONV-A" ? { id, project_id: "PROJECT-A" } : null };
  const communications = { getById: (id) => id === message.id ? message : null };
  const fileService = createFileService({ projectRoot: root });
  return { message, fileService, service: createMarkdownResponseFileService({ projectId: "PROJECT-A", projectRoot: root, conversations, communications, fileService }) };
}

test("Markdown export enforces scope/type and requires explicit overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-markdown-export-"));
  try {
    const { service } = createFixture(root);
    const input = { requestedProjectId: "PROJECT-A", conversationId: "CONV-A", messageId: "MSG-1" };
    const first = await service.save(input);
    assert.equal(await readFile(join(root, first.path), "utf8"), "# Hello\n");
    await assert.rejects(service.save(input), { code: "MARKDOWN_EXPORT_EXISTS", statusCode: 409 });
    const replacement = await service.save({ ...input, confirmOverwrite: true });
    assert.equal(replacement.overwritten, true);
    await assert.rejects(service.save({ ...input, requestedProjectId: "PROJECT-B" }), { code: "PROJECT_NOT_FOUND" });
    const { service: plainService } = createFixture(root, { payload: { text: "plain", content_type: "text/plain" } });
    await assert.rejects(plainService.save(input), { code: "MARKDOWN_RESPONSE_NOT_EXPORTABLE" });
    const { service: ownerService } = createFixture(root, { sender: { role: "project_owner" } });
    await assert.rejects(ownerService.save(input), { code: "MARKDOWN_RESPONSE_NOT_FOUND" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Markdown export route requires the exact message route and fails closed without service", async () => {
  const route = createForgeV1ConversationRoutes({});
  const url = new URL("http://localhost/forge/v1/conversations/CONV-A/messages/MSG-1/markdown-file?project=PROJECT-A");
  await assert.rejects(route.routeConversation({ method: "POST", parts: ["conversations", "CONV-A", "messages", "MSG-1", "markdown-file"], url, body: {}, projectId: "PROJECT-A" }), { statusCode: 503 });
});

test("Markdown export rejects a symlinked export directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-markdown-export-"));
  const outside = await mkdtemp(join(tmpdir(), "nodeforge-markdown-outside-"));
  try {
    await symlink(outside, join(root, "exports"));
    const { service } = createFixture(root);
    await assert.rejects(service.save({ requestedProjectId: "PROJECT-A", conversationId: "CONV-A", messageId: "MSG-1" }), { code: "MARKDOWN_EXPORT_PATH_INVALID" });
    assert.deepEqual(await readdir(outside), []);
  } finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); }
});
