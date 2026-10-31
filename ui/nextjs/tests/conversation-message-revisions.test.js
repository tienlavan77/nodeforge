// Verifies inline owner corrections persist through the chat API and collapse into the reloaded conversation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createHomeMessageHandlers } from "../lib/home-page-message-handlers.js";
import { mergeConversationRevisions, resizeInlineEditTextarea } from "../lib/conversation-message-revisions.js";
import { reconcileConversationHistory } from "../lib/conversation-history-reconciliation.js";

// Preserve the original transcript position when a later edit arrives from another history page.
test("reloaded revisions replace owner text without hiding agent replies", () => {
  const original = { id: "MSG-1", stream_key: "owner:MSG-1", from: "owner", text: "Before", timestamp: "2026-01-01" };
  const response = { id: "MSG-2", stream_key: "agent:MSG-2", from: "agent", text: "Reply", timestamp: "2026-01-02" };
  const revision = { id: "MSG-1", source_message_id: "MSG-3", stream_key: "owner:MSG-1", from: "owner", text: "After", timestamp: "2026-01-03" };
  assert.deepEqual(mergeConversationRevisions([original, response, revision]).map(({ id, text }) => [id, text]), [["MSG-1", "After"], ["MSG-2", "Reply"]]);
  assert.equal(mergeConversationRevisions([original, ...mergeConversationRevisions([response, revision])])[0].text, "After");
});

// Post an owner correction with its original message id, updating the visible message only after the API accepts it.
test("inline edit saves a linked revision through the owner message endpoint", async () => {
  const owner = { id: "MSG-ORIGINAL", stream_key: "owner:MSG-ORIGINAL", from: "owner", text: "Old" };
  const posts = [];
  let messages = [owner];
  const handlers = createHomeMessageHandlers({
    client: { postOwnerMessage: async (input) => { posts.push(input); } }, projectId: "PROJECT-1", activeConversationId: "CONV-1",
    selectedArchitectureManager: { id: "architecture-manager" }, sendingRef: { current: false }, lastSentRef: { current: null },
    setMessages: (update) => { messages = update(messages); }, setAgentTyping: () => {}, setChatState: () => {}, messageIntent: "normal_chat"
  });
  await handlers.editMessage(owner, "  Corrected  ");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].supersedesMessageId, "MSG-ORIGINAL");
  assert.equal(posts[0].text, "Corrected");
  assert.equal(messages[0].id, "MSG-ORIGINAL");
  assert.equal(messages[0].text, "Corrected");
  assert.equal(messages[0].source_message_id, posts[0].messageId);
  assert.equal(messages[0].pending, false);
});

test("System Engineer retries use a System Engineer execution identity", async () => {
  const posts = [];
  const handlers = createHomeMessageHandlers({
    client: { postOwnerMessage: async (input) => posts.push(input) }, projectId: "PROJECT-1", activeConversationId: "123e4567-e89b-42d3-a456-426614174000",
    selectedArchitectureManager: { id: "engineer", role: "system_engineer" }, executionRole: "system-engineer", sendingRef: { current: false }, lastSentRef: { current: null },
    setMessages: () => {}, setAgentTyping: () => {}, setChatState: () => {}, messageIntent: "normal_chat"
  });
  await handlers.retryMessage({ id: "MSG-1", text: "Continue" });
  assert.match(posts[0].correlationId, /^CORR-system-engineer-RETRY-/);
});

test("reconcileConversationHistory and mergeConversationRevisions prevent 2x duplication of handoff and command result messages", () => {
  const live = [
    { id: "MSG-HANDOFF-AM-1", stream_key: "agent:CORR-CONSENSUS", correlation_id: "CORR-CONSENSUS", from: "agent", text: "### Chốt thống nhất kế hoạch giữa AM & SE", timestamp: "2026-10-30T09:00:08Z" },
    { id: "MSG-HANDOFF-AM-2", stream_key: "agent:CORR-SL-DONE", correlation_id: "CORR-SL-DONE", from: "agent", text: "Đã hoàn tất bàn giao kế hoạch PLAN-PROJECT-NODEFORGE", timestamp: "2026-10-30T09:08:24Z" },
    { id: "MSG-COMMAND-1", stream_key: "agent:CORR-CMD", correlation_id: "CORR-CMD", from: "agent", text: "Đã tạo kế hoạch PLAN-PROJECT-NODEFORGE r1", timestamp: "2026-10-30T09:08:25Z" }
  ];
  const history = [
    { id: "MSG-HANDOFF-AM-1", source_message_id: "MSG-HANDOFF-AM-1", stream_key: "agent:MSG-HANDOFF-AM-1", correlation_id: "CORR-CONSENSUS", from: "agent", text: "### Chốt thống nhất kế hoạch giữa AM & SE", timestamp: "2026-10-30T09:00:08Z" },
    { id: "MSG-HANDOFF-SE-1", source_message_id: "MSG-HANDOFF-SE-1", stream_key: "agent:MSG-HANDOFF-SE-1", correlation_id: "CORR-CONSENSUS", from: "agent", text: "### Chốt thống nhất kế hoạch giữa AM & SE", timestamp: "2026-10-30T09:00:08Z" },
    { id: "MSG-HANDOFF-AM-2", source_message_id: "MSG-HANDOFF-AM-2", stream_key: "agent:MSG-HANDOFF-AM-2", correlation_id: "CORR-SL-DONE", from: "agent", text: "Đã hoàn tất bàn giao kế hoạch PLAN-PROJECT-NODEFORGE", timestamp: "2026-10-30T09:08:24Z" },
    { id: "MSG-HANDOFF-SE-2", source_message_id: "MSG-HANDOFF-SE-2", stream_key: "agent:MSG-HANDOFF-SE-2", correlation_id: "CORR-SL-DONE", from: "agent", text: "Đã hoàn tất bàn giao kế hoạch PLAN-PROJECT-NODEFORGE", timestamp: "2026-10-30T09:08:24Z" },
    { id: "MSG-COMMAND-1", source_message_id: "MSG-COMMAND-1", stream_key: "agent:MSG-COMMAND-1", correlation_id: "CORR-CMD", from: "system", text: "Đã tạo kế hoạch PLAN-PROJECT-NODEFORGE r1", timestamp: "2026-10-30T09:08:25Z" }
  ];
  const reconciled = reconcileConversationHistory(live, mergeConversationRevisions(history));
  assert.equal(reconciled.length, 3);
  assert.deepEqual(reconciled.map((m) => m.text), [
    "### Chốt thống nhất kế hoạch giữa AM & SE",
    "Đã hoàn tất bàn giao kế hoạch PLAN-PROJECT-NODEFORGE",
    "Đã tạo kế hoạch PLAN-PROJECT-NODEFORGE r1"
  ]);

  const rawJsonReply = {
    id: "MSG-RAW-JSON",
    stream_key: "agent:MSG-RAW-JSON",
    from: "agent",
    text: JSON.stringify({
      title: "Thống nhất bố cục giao diện 4 trang",
      objective: "Đồng bộ hóa giao diện AM, System, Coding, Agents.",
      scope: ["In scope: 4 trang"],
      outcomes: [{ id: "O1", outcome: "Loại bỏ mục Projects ở sidebar", acceptance_criteria: ["Không render Projects"], guardrails: ["Giữ trạng thái thu gọn"] }],
      verification: "Chạy test UI."
    }),
    timestamp: "2026-10-30T11:07:35Z"
  };
  const formatted = mergeConversationRevisions([rawJsonReply]);
  assert.equal(formatted.length, 1);
  assert.equal(formatted[0].content_type, "text/markdown");
  assert.match(formatted[0].text, /## Đề xuất thiết kế kiến trúc: Thống nhất bố cục giao diện 4 trang/);
  assert.doesNotMatch(formatted[0].text, /^\{/);
});

test("owner inline editor sizing, composer dimensions, and project Git toolbar preserve layout contracts", async () => {
  const [actions, messageStyles, composerStyles, toolMode] = await Promise.all([
    readFile("ui/nextjs/components/conversation-message-actions.jsx", "utf8"),
    readFile("ui/nextjs/app/styles/message-actions.css", "utf8"),
    readFile("ui/nextjs/app/styles/home-conversation.css", "utf8"),
    readFile("ui/nextjs/components/system-tool-mode.jsx", "utf8")
  ]);

  assert.match(composerStyles, /\.claude-composer-wrap \{[^}]*padding: 12px 0 30px;/);
  assert.match(composerStyles, /\.claude-composer-wrap \.home-composer textarea \{[^}]*min-height: 110px;/);
  assert.match(messageStyles, /\.claude-message-inline-edit \{[\s\S]*?width: min\(100%, 700px\);[\s\S]*?box-sizing: border-box;/);
  assert.match(messageStyles, /\.claude-message-inline-edit textarea \{[\s\S]*?width: 100%;[\s\S]*?box-sizing: border-box;[\s\S]*?overflow-y: hidden;/);
  assert.match(actions, /useLayoutEffect[\s\S]*?resizeInlineEditTextarea\(editTextareaRef\.current\)/);
  assert.match(actions, /onChange=\{\(event\) => \{ resizeInlineEditTextarea\(event\.currentTarget\); setDraft\(event\.target\.value\); \}\}/);
  assert.match(toolMode, /className="claude-composer-tool-mode"[\s\S]*?\{projectGit\}[\s\S]*?composer-agent-settings-toggle/);

  const transitions = [];
  let measuredHeight = 186;
  const fakeTextarea = {
    style: {
      set height(value) {
        transitions.push(value);
      },
      get height() {
        return transitions.at(-1) ?? "";
      }
    },
    get scrollHeight() {
      return measuredHeight;
    }
  };
  assert.equal(resizeInlineEditTextarea(fakeTextarea), 186);
  assert.deepEqual(transitions, ["auto", "186px"]);
  measuredHeight = 92;
  assert.equal(resizeInlineEditTextarea(fakeTextarea), 92);
  assert.deepEqual(transitions, ["auto", "186px", "auto", "92px"]);
});
