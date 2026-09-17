// Inter-agent message bus that persists via store and routes to subscribers and global observers.
import { ConfigurationError } from "../../shared/errors.js";
import { createAgentCommunicationStore } from "./agent-communication-store.js";

// Creates a bus that persists messages and delivers them to targeted and global subscribers.
export function createAgentCommunicationBus({ store = createAgentCommunicationStore() } = {}) {
  if (typeof store?.append !== "function") throw new ConfigurationError("Agent Communication Bus requires a communication store.");
  const subscribers = new Map();
  const observers = [];
  const fastIds = new Set();

  return Object.freeze({ send, sendFast, flush, subscribe, unsubscribe, subscribeAll, unsubscribeAll });

  // Persists a message and notifies observers and the recipient's subscribers.
  function send(message) {
    // Persist first so a handler can never observe an unaudited message.
    const persisted = store.append(message);
    // Node observers see the canonical message before its recipient starts work.
    for (const handler of observers) handler(structuredClone(persisted));
    const handlers = subscribers.get(persisted.recipient.id) ?? [];
    for (const handler of handlers) handler(structuredClone(persisted));
    return structuredClone(persisted);
  }

  // Stream deltas are realtime-only. The completion path persists one canonical assistant message.
  // Forwards realtime stream deltas without persistence, deduped by message id.
  function sendFast(message) {
    if (!message?.message_type?.endsWith(".message.delta") && !message?.message_type?.endsWith(".message.progress")) throw new ConfigurationError("Fast communication is limited to agent stream progress and deltas.");
    if (!message?.id || fastIds.has(message.id)) return structuredClone(message);
    fastIds.add(message.id);
    for (const handler of observers) handler(structuredClone(message));
    return structuredClone(message);
  }

  // No-op flush to satisfy bus lifecycle callers.
  async function flush() {}

  // Registers a handler for a specific recipient id.
  function subscribe(receiver, handler) {
    assertReceiver(receiver);
    if (typeof handler !== "function") throw new ConfigurationError("Communication subscriber handler must be a function.");
    const handlers = subscribers.get(receiver) ?? [];
    if (!handlers.includes(handler)) handlers.push(handler);
    subscribers.set(receiver, handlers);
    return Object.freeze({ receiver, handler });
  }

  // Removes a handler for a specific recipient id.
  function unsubscribe(receiver, handler) {
    assertReceiver(receiver);
    if (typeof handler !== "function") throw new ConfigurationError("Communication subscriber handler must be a function.");
    const handlers = subscribers.get(receiver);
    if (!handlers) return false;
    const index = handlers.indexOf(handler);
    if (index < 0) return false;
    handlers.splice(index, 1);
    if (handlers.length === 0) subscribers.delete(receiver);
    return true;
  }

  // Registers a global observer for all messages.
  function subscribeAll(handler) {
    if (typeof handler !== "function") throw new ConfigurationError("Communication observer handler must be a function.");
    if (!observers.includes(handler)) observers.push(handler);
    return Object.freeze({ handler });
  }

  // Removes a previously registered global observer.
  function unsubscribeAll(handler) {
    if (typeof handler !== "function") throw new ConfigurationError("Communication observer handler must be a function.");
    const index = observers.indexOf(handler);
    if (index < 0) return false;
    observers.splice(index, 1);
    return true;
  }
}

// Validates that a communication receiver identifier is present.
function assertReceiver(receiver) {
  if (typeof receiver !== "string" || receiver.length === 0) throw new ConfigurationError("A communication receiver is required.");
}
