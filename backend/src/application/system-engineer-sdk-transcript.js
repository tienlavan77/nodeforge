// Normalizes Codex JSONL items and Claude content-block streams into one ordered
// owner reply. Provider IDs keep updates in their original positions; command output,
// hidden reasoning, and subagent messages never enter the public transcript.

// Maintains one SDK run's public blocks so live updates and replay share identical ordering.
export function createSystemEngineerSdkTranscript(runId) {
  const entries = new Map();
  const blocks = new Map();
  let messageId;
  let status = "working";
  let providerFailed = false;
  let revision = 0;

  // Replaces a provider snapshot without moving its initial position in the reply.
  function put(id, value) {
    const key = `${runId}:${id}`;
    const previous = entries.get(key);
    const next = { ...previous, ...value, id: key, timestamp: previous?.timestamp ?? new Date().toISOString() };
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    entries.set(key, next);
    revision++;
  }

  // Preserves command identity and state while bounding only public text, not command execution.
  function command(id, input, state) {
    if (typeof input !== "string" || !input.trim()) return;
    const words = input.trim().match(/\S+/g) ?? [];
    put(id, { type: "command_execution", command: words.length > 250 ? `${words.slice(0, 250).join(" ")} …` : input.trim(), status: state });
  }

  // Consumes native events, including Claude partial blocks and their complete-message snapshots.
  function accept(event) {
    if (!event || event.parent_tool_use_id) return false;
    const before = revision;
    if (event.type === "turn.failed" || event.type === "error" || event.type === "result" && event.is_error) providerFailed = true;
    if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
      const item = event.item ?? {};
      const id = item.id ?? "command";
      if (item.type === "agent_message") put(id, { type: "text", text: item.text ?? "" });
      if (item.type === "command_execution") command(id, item.command, item.status === "failed" || Number.isInteger(item.exit_code) && item.exit_code !== 0 ? "failed" : event.type === "item.completed" ? "success" : "working");
    }
    if (event.type === "stream_event") {
      const partial = event.event ?? {};
      if (partial.type === "message_start") { messageId = partial.message.id; blocks.clear(); }
      const key = `${messageId}:${partial.index}`;
      if (partial.type === "content_block_start") {
        const block = { ...partial.content_block, key, json: "" };
        blocks.set(partial.index, block);
        if (block.type === "text") put(key, { type: "text", text: block.text ?? "" });
        if (block.type === "tool_use") command(block.id, block.input?.command, "working");
      }
      const block = blocks.get(partial.index);
      if (partial.type === "content_block_delta" && block) {
        if (partial.delta?.type === "text_delta") {
          block.text = `${block.text ?? ""}${partial.delta.text}`;
          put(block.key, { type: "text", text: block.text });
        }
        if (partial.delta?.type === "input_json_delta") block.json += partial.delta.partial_json;
      }
      if (partial.type === "content_block_stop" && block?.type === "tool_use" && block.json) {
        try { command(block.id, JSON.parse(block.json).command, "working"); }
        catch (error) { throw new Error("Claude streamed tool input is not valid JSON.", { cause: error }); }
      }
    }
    if (event.type === "assistant") {
      for (const [index, block] of (event.message?.content ?? []).entries()) {
        if (block.type === "text") {
          const streamed = messageId === event.message.id && [...blocks.values()].find((entry) => entry.type === "text" && entry.text === block.text);
          put(streamed?.key ?? `${event.message.id ?? event.uuid}:${index}`, { type: "text", text: block.text });
        }
        if (block.type === "tool_use") command(block.id, block.input?.command, "working");
      }
    }
    if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        const previous = entries.get(`${runId}:${block.tool_use_id}`);
        if (block.type === "tool_result" && previous) put(block.tool_use_id, { status: block.is_error ? "failed" : "success" });
      }
    }
    return revision !== before;
  }

  // Supplies a final-text fallback only when a provider produced no public text events.
  function finish(text, failed = false) {
    if (text && ![...entries.values()].some((entry) => entry.type === "text" && entry.text)) put("fallback", { type: "text", text });
    status = failed || providerFailed ? "failed" : "success";
    revision++;
  }

  return { accept, finish, snapshot: () => ({ type: "conversation_turn", run_id: runId, revision, status, entries: [...entries.values()] }) };
}
