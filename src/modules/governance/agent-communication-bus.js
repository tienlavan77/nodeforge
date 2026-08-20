import { ConfigurationError } from "../../shared/errors.js";
import { createAgentCommunicationStore } from "./agent-communication-store.js";

export function createAgentCommunicationBus({ store = createAgentCommunicationStore() } = {}) {
  if (typeof store?.append !== "function") throw new ConfigurationError("Agent Communication Bus requires a communication store.");
  const subscribers = new Map();
  const observers = [];

  return Object.freeze({ send, subscribe, unsubscribe, subscribeAll, unsubscribeAll });

  function send(message) {
    // Persist first so a handler can never observe an unaudited message.
    const persisted = store.append(message);
    // Node observers see the canonical message before its recipient starts work.
    for (const handler of observers) handler(structuredClone(persisted));
    const handlers = subscribers.get(persisted.recipient.id) ?? [];
    for (const handler of handlers) handler(structuredClone(persisted));
    return structuredClone(persisted);
  }

  function subscribe(receiver, handler) {
    assertReceiver(receiver);
    if (typeof handler !== "function") throw new ConfigurationError("Communication subscriber handler must be a function.");
    const handlers = subscribers.get(receiver) ?? [];
    if (!handlers.includes(handler)) handlers.push(handler);
    subscribers.set(receiver, handlers);
    return Object.freeze({ receiver, handler });
  }

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

  function subscribeAll(handler) {
    if (typeof handler !== "function") throw new ConfigurationError("Communication observer handler must be a function.");
    if (!observers.includes(handler)) observers.push(handler);
    return Object.freeze({ handler });
  }

  function unsubscribeAll(handler) {
    if (typeof handler !== "function") throw new ConfigurationError("Communication observer handler must be a function.");
    const index = observers.indexOf(handler);
    if (index < 0) return false;
    observers.splice(index, 1);
    return true;
  }
}

function assertReceiver(receiver) {
  if (typeof receiver !== "string" || receiver.length === 0) throw new ConfigurationError("A communication receiver is required.");
}
