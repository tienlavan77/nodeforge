// Exchanges bounded JSON frames with the owner-only namespace socket. Closing
// an interrupted request also stops its active verifier inside the server.
import { createConnection } from "node:net";

// Preserves streaming output and the server's exact receipt reference while
// rejecting early disconnects, malformed responses and unresponsive runners.
export function requestFilesystemNamespace(socketPath, request, { signal, timeoutMs = 5000, onOutput = () => {} } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let pending = "";
    let finished = false;
    const timer = setTimeout(() => finish(Object.assign(new Error("Filesystem runner request timed out."), { code: "VERIFY_RUNNER_TIMEOUT" })), timeoutMs);
    // Defines abort function behavior for filesystem-namespace-client.js.
    const abort = () => finish(signal.reason);
    // Releases socket and cancellation resources exactly once for each request.
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    socket.once("error", error => finish(error));
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", chunk => {
      pending += chunk;
      if (Buffer.byteLength(pending) > 1_000_000) { finish(new Error("Filesystem runner response exceeds its frame budget.")); return; }
      const lines = pending.split("\n");
      pending = lines.pop();
      try {
        for (const line of lines) {
          const frame = JSON.parse(line);
          if (frame.error) throw Object.assign(new Error(frame.error), { code: "VERIFY_RUNNER_FAILED" });
          if (frame.stream) onOutput(frame.stream, frame.data);
          else if (frame.identity || Number.isInteger(frame.exitCode)) { finish(null, frame); return; }
        }
      } catch (error) { finish(error); }
    });
    socket.once("close", () => { if (!finished) finish(Object.assign(new Error("Filesystem runner closed without a result."), { code: "VERIFY_RUNNER_DISCONNECTED" })); });
  });
}
