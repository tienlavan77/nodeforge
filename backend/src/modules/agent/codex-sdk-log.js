// Exposes Codex startup, retry and stalled event streams without logging prompts or source code.

// Logs SDK lifecycle boundaries and distinguishes an alive process from observable progress.
export function createCodexSdkLog({ profile, correlationId, output = process.stdout, credential, now = Date.now, intervalMs = 30000 }) {
  const started = now();
  let lastEventAt = started;
  let stage = "initializing SDK";
  let lastTextLog = 0;
  // Redacts provider credentials and URLs before writing bounded terminal diagnostics.
  function write(message) {
    const safe = String(message).replaceAll(credential || "\0", "[REDACTED]").replace(/(?:https?|wss?):\/\/\S+/g, "[URL]").replace(/[\r\n]+/g, " ").slice(0, 600);
    output?.write?.(`[Codex SDK] ${new Date(now()).toISOString()} ${profile.agent_name ?? profile.agent_id} ${safe} correlation=${correlationId}\n`);
  }
  write(`START model=${profile.model ?? "default"} effort=${profile.reasoning?.effort ?? "default"}`);
  const timer = setInterval(() => {
    const idle = Math.floor((now() - lastEventAt) / 1000);
    if (idle >= intervalMs / 1000) write(`WAIT no SDK events for ${idle}s; last=${stage}; elapsed=${Math.floor((now() - started) / 1000)}s. Runner alive; progress unconfirmed.`);
  }, intervalMs);
  timer.unref?.();
  return {
    // Reports boundaries without treating session startup as model or tool progress.
    event(event) {
      lastEventAt = now();
      const type = event.type;
      if (["error", "turn.failed"].includes(type)) {
        stage = type;
        write(`${type === "error" ? "RETRY/ERROR" : "FAIL"} ${event.message ?? event.error?.message ?? "Unknown SDK error"}`);
      } else if (["thread.started", "turn.started", "turn.completed"].includes(type)) {
        stage = type;
        write(type === "turn.started" ? "TURN STARTED; waiting for model output" : type);
      } else if (type?.startsWith("item.")) {
        stage = `${type}:${event.item?.type ?? "unknown"}`;
        if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(event.item?.type) && type !== "item.updated") write(stage);
        else if (event.item?.type === "agent_message" && (!lastTextLog || now() - lastTextLog > intervalMs)) { lastTextLog = now(); write("Model response received"); }
      }
    },
    // Releases the diagnostic timer when the SDK turn settles or is stopped.
    close(error) { clearInterval(timer); write(error ? `STOP/FAIL ${error.message ?? error}` : "DONE"); }
  };
}
