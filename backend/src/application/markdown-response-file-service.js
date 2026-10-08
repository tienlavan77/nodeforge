// Summary: Safely saves explicitly typed owner-visible Markdown responses as project files.
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { ConfigurationError } from "../shared/errors.js";

const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

// Creates a project-scoped Markdown export service with immutable-message and path checks.
export function createMarkdownResponseFileService({ projectId, projectRoot, conversations, communications, fileService, logger = () => {} } = {}) {
  if (typeof projectId !== "string" || !projectId || typeof projectRoot !== "string" || !projectRoot) throw new ConfigurationError("Markdown response export requires project identity and root.");
  if (typeof conversations?.get !== "function" || typeof communications?.getById !== "function" || typeof fileService?.atomicCreate !== "function" || typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("Markdown response export requires conversation, communication, and file services.");
  return Object.freeze({ save });

  // Saves a canonical assistant response only after revalidating its conversation and format.
  async function save({ requestedProjectId, conversationId, messageId, confirmOverwrite = false } = {}) {
    if (requestedProjectId !== projectId) throw httpError("Project file is unavailable.", 404, "PROJECT_NOT_FOUND");
    if (typeof conversationId !== "string" || !conversationId || typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) throw httpError("Markdown response identity is invalid.", 400, "MARKDOWN_EXPORT_INPUT_INVALID");
    if (typeof confirmOverwrite !== "boolean") throw httpError("confirm_overwrite must be boolean.", 400, "MARKDOWN_EXPORT_INPUT_INVALID");
    const conversation = conversations.get(conversationId);
    if (!conversation || conversation.project_id !== projectId) throw httpError("Conversation not found.", 404, "CONVERSATION_NOT_FOUND");
    const message = communications.getById(messageId);
    if (!message || message.project_id !== projectId || message.conversation_id !== conversationId || message.sender?.role === "project_owner" || message.sender?.role === "node" || !String(message.message_type ?? "").endsWith(".message.received")) throw httpError("Agent response not found in this conversation.", 404, "MARKDOWN_RESPONSE_NOT_FOUND");
    const payload = message.payload ?? {};
    const markdown = payload.content_type === "text/markdown" || (payload.content_type === undefined && payload.markdown_provenance === "owner-markdown-opt-in-v1");
    if (!markdown || typeof payload.text !== "string") throw httpError("Only explicitly declared Markdown responses can be saved.", 409, "MARKDOWN_RESPONSE_NOT_EXPORTABLE");
    const path = `exports/agent-response-${messageId}.md`;
    await assertSafeParent(projectRoot, path);
    let result;
    try {
      result = confirmOverwrite
        ? await fileService.atomicWrite({ path, content: payload.text, replace: true })
        : await fileService.atomicCreate({ path, content: payload.text });
    } catch (error) {
      if (error?.code === "FILE_ALREADY_EXISTS") throw httpError("The Markdown export already exists; confirm overwrite to replace it.", 409, "MARKDOWN_EXPORT_EXISTS", { path });
      throw error;
    }
    const sha256 = createHash("sha256").update(payload.text).digest("hex");
    logger({ event_name: "conversation.markdown_export", status: "success", message: "Agent Markdown response saved to project file.", project_id: projectId, conversation_id: conversationId, source: "markdown-response-file-service", payload: { message_id: messageId, path, bytes: result.bytes, sha256, overwritten: confirmOverwrite } });
    return { path, sha256, bytes: result.bytes, overwritten: confirmOverwrite };
  }
}

// Rejects symlinked export directories before File Service creates or replaces the target.
async function assertSafeParent(projectRoot, path) {
  const root = await realpath(projectRoot);
  const parent = resolve(root, path).split(sep).slice(0, -1).join(sep);
  const relativeParent = relative(root, parent);
  let current = root;
  for (const part of relativeParent.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw httpError("Markdown export directory is unsafe.", 400, "MARKDOWN_EXPORT_PATH_INVALID");
      const resolved = await realpath(current);
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw httpError("Markdown export directory escapes the project.", 400, "MARKDOWN_EXPORT_PATH_INVALID");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

// Builds a status-bearing domain error for the Markdown export route.
function httpError(message, statusCode, code, extra = {}) { return Object.assign(new ConfigurationError(message), { statusCode, code, ...extra }); }
