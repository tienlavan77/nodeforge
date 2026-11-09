// Keeps health checks responsive while project services initialize. The existing HTTP
// application is attached to the same listening socket only after composition succeeds;
// requests arriving earlier receive an explicit retryable readiness response.
import { createServer } from "node:http";

// Opens transport independently of project initialization and transfers request handling
// atomically once the fully composed application is available.
export function createStartupTransport({ port, host }) {
  let state = "starting";
  let handler;
  const server = createServer((request, response) => {
    if (handler) return handler(request, response);
    const health = ["/health", "/healthz", "/readyz"].includes(request.url?.split("?")[0]);
    response.writeHead(health && request.url !== "/readyz" ? 200 : 503, {
      "Content-Type": "application/json", "Retry-After": "2",
      "Access-Control-Allow-Origin": "*"
    });
    response.end(JSON.stringify({ status: state, ready: false, code: "API_INITIALIZING" }));
  });
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      process.stdout.write(`Node Control API listening on http://${host}:${server.address().port} (initializing)\n`);
      resolve();
    });
  });
  return {
    server, listening,
    // Publishes the complete request handler without creating a second listening socket.
    attach(api) {
      const composed = api.createServer();
      const listeners = composed.listeners("request");
      if (listeners.length !== 1) throw new Error("Expected one Control API request handler.");
      handler = listeners[0].bind(composed);
      state = "ready";
      return server;
    },
    // Closes the early socket on initialization failure so supervisors can retry cleanly.
    async fail(error) {
      state = "failed";
      console.error("Control API initialization failed.", error);
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
