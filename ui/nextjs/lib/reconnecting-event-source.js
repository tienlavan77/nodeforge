// Restores live UI subscriptions after API downtime without requiring a page reload or replaying commands.

// Reopens terminal SSE connections with the last event cursor while retaining native network retries.
export function createReconnectingEventSource(urlForCursor, { afterEventId = null, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let source;
  let timer = null;
  let closed = false;
  let attempts = 0;
  let lastEventId = afterEventId;
  const listeners = new Map();
  const connection = {
    onopen: null,
    onerror: null,
    get readyState() { return closed ? 2 : source.readyState; },
    // Keeps subscribed event handlers attached across replacement connections.
    addEventListener(type, handler) {
      const handlers = listeners.get(type) ?? new Set();
      if (handlers.has(handler)) return;
      handlers.add(handler);
      listeners.set(type, handlers);
      source.addEventListener(type, wrap(source, handler));
    },
    // Cancels pending reconnects when the page or final shared subscriber leaves.
    close() {
      closed = true;
      if (timer !== null) cancel(timer);
      timer = null;
      source.close();
      listeners.clear();
    }
  };

  // Ignores stale sockets and preserves replay position before delivering events to UI consumers.
  function wrap(current, handler) {
    return (event) => {
      if (closed || current !== source) return;
      const accepted = handler(event);
      if (accepted !== false && event.lastEventId) lastEventId = event.lastEventId;
    };
  }

  // Reattaches the existing subscription after a terminal response such as a restart-time 503.
  function connect() {
    const current = new EventSource(urlForCursor(lastEventId));
    source = current;
    for (const [type, handlers] of listeners) for (const handler of handlers) current.addEventListener(type, wrap(current, handler));
    current.onopen = (event) => {
      if (closed || current !== source) return;
      attempts = 0;
      connection.onopen?.(event);
    };
    current.onerror = (error) => {
      if (closed || current !== source) return;
      if (current.readyState === 2 && timer === null) {
        const delay = Math.min(1000 * 2 ** Math.min(attempts, 4), 10000);
        attempts += 1;
        timer = schedule(() => { timer = null; if (!closed) { current.close(); connect(); } }, delay);
      }
      connection.onerror?.(error);
    };
  }

  connect();
  return connection;
}
