// Restores persisted conversation replies missed during an SSE interruption without resetting the reader's history.
import { mergeConversationRevisions } from "./conversation-message-revisions.js";

// Replaces matching live replies with authoritative history while retaining older messages and unsent owner drafts.
export function reconcileConversationHistory(current, history) {
  const remaining = new Set(history);
  const messages = current.map((message) => {
    const match = history.find((record) => record.from === message.from && (
      record.id === message.id || record.source_message_id === message.source_message_id && Boolean(record.source_message_id)
      || Boolean(record.correlation_id) && (record.correlation_id === message.correlation_id || message.stream_key === `${message.from}:${record.correlation_id}`)
    ));
    if (!match) return message;
    remaining.delete(match);
    return { ...match, stream_key: message.stream_key, pending: false, stream: false };
  });
  return mergeConversationRevisions([...messages, ...remaining].sort((left, right) => String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""))));
}
