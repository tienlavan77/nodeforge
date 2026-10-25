// Exposes Codex lifecycle and retry events without logging prompts or source code.

// Logs SDK lifecycle boundaries and distinguishes an alive process from observable progress.
export function createCodexSdkLog({ profile, correlationId, output = process.stdout, credential, now = Date.now, intervalMs = 30000 }) {
  let lastTextLog = 0;
  // Redacts provider credentials and URLs before writing bounded terminal diagnostics.
  function write(message) {
    const safe = String(message).replaceAll(credential || "\0", "[REDACTED]").replace(/(?:https?|wss?):\/\/\S+/g, "[URL]").replace(/[\r\n]+/g, " ").slice(0, 600);
    output?.write?.(`[Codex SDK] ${new Date(now()).toISOString()} ${profile.agent_name ?? profile.agent_id} ${safe} correlation=${correlationId}\n`);
  }
  write(`START model=${profile.model ?? "default"} effort=${profile.reasoning?.effort ?? "default"}`);
  return {
    // Reports boundaries without treating session startup as model or tool progress.
    event(event) {
      const type = event.type;
      if (["error", "turn.failed"].includes(type)) {
        write(`${type === "error" ? "RETRY/ERROR" : "FAIL"} ${event.message ?? event.error?.message ?? "Unknown SDK error"}`);
      } else if (["thread.started", "turn.started", "turn.completed"].includes(type)) {
        write(type === "turn.started" ? "TURN STARTED; waiting for model output" : type);
      } else if (type?.startsWith("item.")) {
        const stage = `${type}:${event.item?.type ?? "unknown"}`;
        if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(event.item?.type) && type !== "item.updated") write(stage);
        else if (event.item?.type === "agent_message" && (!lastTextLog || now() - lastTextLog > intervalMs)) { lastTextLog = now(); write("Model response received"); }
      }
    },
    // Records the terminal outcome when the SDK turn settles or is stopped.
    close(error) { write(error ? `STOP/FAIL ${error.message ?? error}` : "DONE"); }
  };
}
