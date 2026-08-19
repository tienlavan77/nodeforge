import { ConfigurationError } from "../../shared/errors.js";

export function createSubscriptionRegistry() {
  const subscriptions = new Map();
  let nextId = 1;

  return Object.freeze({ subscribe, unsubscribe, publish });

  function subscribe(eventType, handler) {
    if (!isPattern(eventType) || typeof handler !== "function") {
      throw new ConfigurationError("Subscription requires an event type pattern and handler.");
    }
    const subscription = Object.freeze({ id: `SUB-${nextId++}`, event_type: eventType });
    subscriptions.set(subscription.id, { ...subscription, handler });
    return subscription;
  }

  function unsubscribe(subscription) {
    const id = typeof subscription === "string" ? subscription : subscription?.id;
    if (typeof id !== "string") throw new ConfigurationError("A subscription is required.");
    return subscriptions.delete(id);
  }

  function publish(event) {
    if (!event || typeof event.event_type !== "string") throw new ConfigurationError("A stored event with event_type is required.");
    let delivered = 0;
    for (const subscription of subscriptions.values()) {
      if (!matches(subscription.event_type, event.event_type)) continue;
      subscription.handler(event);
      delivered += 1;
    }
    return delivered;
  }
}

function isPattern(eventType) {
  return eventType === "*" || typeof eventType === "string" && /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*|\.\*)*$/.test(eventType);
}

function matches(pattern, eventType) {
  return pattern === "*" || pattern.endsWith(".*") ? eventType.startsWith(pattern === "*" ? "" : pattern.slice(0, -1)) : pattern === eventType;
}
