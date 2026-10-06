// Combines append-only owner message revisions into the latest visible conversation message.

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
  return merged;
}
