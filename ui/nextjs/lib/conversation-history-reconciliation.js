// Restores persisted conversation replies missed during an SSE interruption without resetting the reader's history.
import { mergeConversationRevisions } from "./conversation-message-revisions.js";

// Replaces matching live replies with authoritative history while retaining older messages and unsent owner drafts.
export function reconcileConversationHistory(current, history) {
  const remaining = new Set(history);
  const messages = current.map((message) => {
    const match = [...remaining].find((record) => (
      record.id === message.id || record.source_message_id === message.source_message_id && Boolean(record.source_message_id)
      || record.from === message.from && (
        record.se_event && message.se_event && record.stream_key === message.stream_key
        || !record.se_event && !message.se_event && Boolean(record.correlation_id) && (record.correlation_id === message.correlation_id || message.stream_key === `${message.from}:${record.correlation_id}`)
      )
    ));
    if (!match) return message;
    remaining.delete(match);
    for (const duplicate of [...remaining]) {
      if (duplicate.id === match.id || duplicate.correlation_id && duplicate.correlation_id === match.correlation_id && !duplicate.se_event && duplicate.text === match.text) {
        remaining.delete(duplicate);
      }
    }
    const resolvedIdea = typeof match.is_idea === "boolean" && (match.has_explicit_idea !== false || !message.is_idea)
      ? match.is_idea
      : Boolean(message.is_idea ?? match.is_idea);
    if (message.se_event && match.se_event && message.sdk_sequence > match.sdk_sequence) return { ...message, is_idea: resolvedIdea };
    if (message.se_event?.type === "conversation_turn" && !match.se_event) return { ...message, is_idea: resolvedIdea };
    return { ...match, is_idea: resolvedIdea, stream_key: message.stream_key, pending: false, stream: false };
  });
  return mergeConversationRevisions([...messages, ...remaining].sort((left, right) => String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""))));
}
