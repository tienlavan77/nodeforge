import { ConfigurationError } from "../../shared/errors.js";

const STREAM_TYPES = Object.freeze([
  "agent.started",
  "agent.step.started",
  "agent.step.completed",
  "agent.failed",
  "agent.completed"
]);

export function createRuntimeSse({ subscriptions } = {}) {
  if (typeof subscriptions?.subscribe !== "function" || typeof subscriptions?.unsubscribe !== "function") {
    throw new ConfigurationError("Runtime SSE requires a Subscription Registry.");
  }

  return Object.freeze({ connect, eventTypes: STREAM_TYPES });

  function connect(response) {
    if (!response?.write || typeof response.end !== "function") throw new ConfigurationError("SSE connect requires a writable response.");
    response.writeHead?.(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    const subscription = subscriptions.subscribe("agent.*", (event) => {
      if (!STREAM_TYPES.includes(event.event_type)) return;
      response.write(`event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    let closed = false;
    return Object.freeze({
      close() {
        if (closed) return false;
        closed = true;
        subscriptions.unsubscribe(subscription);
        response.end();
        return true;
      }
    });
  }
}
