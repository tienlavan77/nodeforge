// Combines append-only owner message revisions into the latest visible conversation message.
import { withoutSystemEngineerReplyDuplicates } from "./system-engineer-conversation-events.js";

// Keeps the original message position while showing the newest persisted owner text.
export function mergeConversationRevisions(messages) {
  const merged = [];
  const positions = new Map();
  for (const message of messages) {
    const key = message.stream_key ?? `${message.from}:${message.id}`;
    const index = positions.get(key);
    if (index === undefined) {
      positions.set(key, merged.length);
      merged.push(message);
    } else {
      const original = merged[index];
      merged[index] = { ...original, ...message, id: original.id, stream_key: key, timestamp: original.timestamp };
    }
  }
  return withoutSystemEngineerReplyDuplicates(merged).sort(compareConversationTime);
}

// Orders agent text and command records from one conversation by their emitted event time.
// A stable identity fallback keeps equal-timestamp records deterministic across history reloads.
function compareConversationTime(left, right) {
  const time = String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""));
  if (time) return time;
  return String(left.id ?? left.stream_key ?? "").localeCompare(String(right.id ?? right.stream_key ?? ""));
}
