// Combines append-only owner message revisions into the latest visible conversation message.
import { withoutSystemEngineerReplyDuplicates } from "./system-engineer-conversation-events.js";

// Keeps the original message position while showing the newest persisted owner text.
// Business purpose: converts an accidental raw Architecture Plan JSON dump in chat history into human-readable Markdown so the Owner never sees raw JSON walls on the UI.
// Technical description: checks whether an agent message is a JSON object containing title, objective, and outcomes[], and formats it into structured Markdown sections.
function formatRawArchitecturePlanIfPresent(message) {
  if (!message || message.from !== "agent" || message.se_event || typeof message.text !== "string") return message;
  const trimmed = message.text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return message;
  try {
    const plan = JSON.parse(trimmed);
    if (!plan || typeof plan !== "object" || typeof plan.title !== "string" || typeof plan.objective !== "string" || !Array.isArray(plan.outcomes)) return message;
    const outcomes = plan.outcomes.map((item) => [
      `### Hạng mục ${item.id}: ${item.outcome}`,
      ...(item.acceptance_criteria ?? []).map((ac) => `  - Tiêu chí hoàn thành: ${ac}`),
      ...(item.guardrails ?? []).map((gr) => `  - Ranh giới & lưu ý: ${gr}`)
    ].join("\n")).join("\n\n");
    const scope = Array.isArray(plan.scope) && plan.scope.length ? ["", "### 2. Phạm vi thực hiện", ...plan.scope.map((s) => `- ${s}`)].join("\n") : "";
    const formatted = [
      `## Đề xuất thiết kế kiến trúc: ${plan.title}`, "",
      "### 1. Mục tiêu tổng thể", plan.objective,
      ...(plan.background ? ["", "**Bối cảnh:**", plan.background] : []),
      scope, "",
      "### 3. Các hạng mục công việc & Tiêu chí nghiệm thu", outcomes,
      ...(plan.verification ? ["", `**Phương thức kiểm thử & nghiệm thu:** ${plan.verification}`] : [])
    ].filter((line) => line !== "").join("\n\n");
    return { ...message, text: formatted, content_type: "text/markdown" };
  // eslint-disable-next-line no-silent-catch -- Non-JSON agent messages remain untouched.
  } catch {
    return message;
  }
}

export function mergeConversationRevisions(messages) {
  const merged = [];
  const positions = new Map();
  for (const rawMessage of messages) {
    const message = formatRawArchitecturePlanIfPresent(rawMessage);
    const key = message.stream_key ?? `${message.from}:${message.id}`;
    let index = positions.get(key);
    if (index === undefined && message.from !== "owner" && !message.se_event) {
      const found = merged.findIndex((item) => !item.se_event && item.from !== "owner" && (
        Boolean(message.id) && item.id === message.id
        || Boolean(message.source_message_id) && item.source_message_id === message.source_message_id
        || Boolean(message.correlation_id) && item.correlation_id === message.correlation_id && item.text === message.text
      ));
      if (found >= 0) index = found;
    }
    if (index === undefined) {
      positions.set(key, merged.length);
      merged.push(message);
    } else {
      const original = merged[index];
      positions.set(key, index);
      merged[index] = { ...original, ...message, id: original.id, stream_key: original.stream_key ?? key, timestamp: original.timestamp };
    }
  }
  return withoutSystemEngineerReplyDuplicates(merged).sort(compareConversationTime);
}

// Business purpose: resizes the owner inline message editor textarea to fit its full draft text without vertical scrolling when opened or modified.
// Technical description: resets `element.style.height` to `"auto"` and assigns `${element.scrollHeight}px` when `element` is present and has a positive `scrollHeight`.
export function resizeInlineEditTextarea(element) {
  if (!element || !element.style) return 0;
  element.style.height = "auto";
  const nextHeight = Number(element.scrollHeight) || 0;
  if (nextHeight > 0) element.style.height = `${nextHeight}px`;
  return nextHeight;
}

// Orders agent text and command records from one conversation by their emitted event time.
// A stable identity fallback keeps equal-timestamp records deterministic across history reloads.
function compareConversationTime(left, right) {
  const time = String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""));
  if (time) return time;
  return String(left.id ?? left.stream_key ?? "").localeCompare(String(right.id ?? right.stream_key ?? ""));
}
