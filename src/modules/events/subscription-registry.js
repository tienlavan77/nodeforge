import { ConfigurationError } from "../../shared/errors.js";

export function createSubscriptionRegistry({ logger = console, maxFailures } = {}) {
  const subscriptions = new Map();
  const failures = new Map();
  let lastErrors = [];
  let nextId = 1;

  return Object.freeze({ subscribe, unsubscribe, publish, getLastErrors });

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
    lastErrors = [];
    for (const subscription of subscriptions.values()) {
      if (!matches(subscription.event_type, event.event_type)) continue;
      try {
        subscription.handler(event);
        delivered += 1;
        failures.delete(subscription.id);
      } catch (error) {
        const failure = { subscription_id: subscription.id, event_type: subscription.event_type, handler: subscription.handler.name || "anonymous", error: error?.message ?? String(error) };
        lastErrors.push(Object.freeze(failure));
        const failureCount = (failures.get(subscription.id) ?? 0) + 1;
        failures.set(subscription.id, failureCount);
        logger.error?.("Event subscription handler failed", failure);
        if (Number.isInteger(maxFailures) && maxFailures > 0 && failureCount >= maxFailures) subscriptions.delete(subscription.id);
      }
    }
    return delivered;
  }

  function getLastErrors() {
    return lastErrors.map((error) => ({ ...error }));
  }
}

function isPattern(eventType) {
  return eventType === "*" || typeof eventType === "string" && /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*|\.\*)*$/.test(eventType);
}

function matches(pattern, eventType) {
  return pattern === "*" || pattern.endsWith(".*") ? eventType.startsWith(pattern === "*" ? "" : pattern.slice(0, -1)) : pattern === eventType;
}
