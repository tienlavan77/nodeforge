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
      const itemState = item.status === "failed" || Boolean(item.error) || Number.isInteger(item.exit_code) && item.exit_code !== 0 ? "failed" : event.type === "item.completed" ? "success" : "working";
      if (item.type === "agent_message") put(id, { type: "text", text: item.text ?? "" });
      if (item.type === "command_execution") command(id, item.command, itemState);
      if (item.type === "mcp_tool_call" && item.server === "forge" && (item.arguments !== undefined || item.input !== undefined)) {
        command(id, formatForgeToolCommand(item.tool, item.arguments ?? item.input, true), itemState);
      }
    }
    if (event.type === "stream_event") {
      const partial = event.event ?? {};
      if (partial.type === "message_start") { messageId = partial.message.id; blocks.clear(); }
      const key = `${messageId}:${partial.index}`;
      if (partial.type === "content_block_start") {
        const block = { ...partial.content_block, key, json: "" };
        blocks.set(partial.index, block);
        if (block.type === "text") put(key, { type: "text", text: block.text ?? "" });
        if (block.type === "tool_use") command(block.id, formatForgeToolCommand(block.name, block.input, false), "working");
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
        try { command(block.id, formatForgeToolCommand(block.name, JSON.parse(block.json), true), "working"); }
        catch (error) { throw new Error("Claude streamed tool input is not valid JSON.", { cause: error }); }
      }
    }
    if (event.type === "assistant") {
      for (const [index, block] of (event.message?.content ?? []).entries()) {
        if (block.type === "text") {
          const streamed = messageId === event.message.id && [...blocks.values()].find((entry) => entry.type === "text" && entry.text === block.text);
          put(streamed?.key ?? `${event.message.id ?? event.uuid}:${index}`, { type: "text", text: block.text });
        }
        if (block.type === "tool_use") command(block.id, formatForgeToolCommand(block.name, block.input, true), "working");
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

const FORGE_TOOLS = new Set(["search_tree", "list_files", "search_text", "read_file", "read_file_binary", "Read", "write_diff", "edit_diff", "delete_file", "move_file", "git_status", "git_diff", "run_check", "commit_changes", "push_commit", "lookup_schema", "select_code_graph_candidates", "search_code", "rg_files", "rg_search", "sed_lines", "run_test", "check_test", "report_done", "respond_to_review", "review_diff", "run_review_check", "query_review"]);

// Business purpose: gives the project owner live, detailed visibility into every Forge tool command executed by agents in the agent activity monitor without leaking file contents or secrets.
// Technical description: normalizes MCP and direct Forge tool invocations into a bounded CLI-style command string with paths, line ranges, symbols, search patterns, and flags.
export function formatForgeToolCommand(rawName, rawInput, complete = true) {
  let input = rawInput;
  if (typeof rawInput === "string") {
    // eslint-disable-next-line no-silent-catch -- Best-effort parse for serialized MCP tool arguments.
    try { input = JSON.parse(rawInput); } catch { input = {}; }
  }
  if (typeof rawName !== "string") return "";
  const name = rawName.replace(/^mcp__forge__/, "");
  if (name === "run_check" && typeof input?.command === "string" && input.command.trim()) {
    return `${name}${input.type ? ` [${input.type}]` : ""} ${input.command.trim()}`;
  }
  if (typeof input?.command === "string" && input.command.trim()) return input.command.trim();
  if (!rawName.startsWith("mcp__forge__") && !FORGE_TOOLS.has(name)) return "";
  if (!input || typeof input !== "object" || (!complete && !Object.keys(input).length)) return "";
  if (name === "search_text" || name === "rg_search") return [name, ...(Array.isArray(input.flags) ? input.flags : []), typeof input.pattern === "string" ? JSON.stringify(input.pattern) : "", ...(Array.isArray(input.paths) ? input.paths : [])].filter(Boolean).join(" ");
  if (name === "search_tree") return [name, input.path ?? ".", Number.isInteger(input.max_depth) ? `--max-depth=${input.max_depth}` : "", Number.isInteger(input.limit) ? `--limit=${input.limit}` : ""].filter(Boolean).join(" ");
  if (name === "list_files" || name === "rg_files") return [name, ...(Array.isArray(input.flags) ? input.flags : [ "--default" ])].filter(Boolean).join(" ");
  if (name === "read_file") {
    const range = typeof input.symbol === "string" && input.symbol ? `#${input.symbol}` : Number.isInteger(input.offset) || Number.isInteger(input.limit) ? `:${input.offset ?? 1}..${(input.offset ?? 1) + (input.limit ?? 250) - 1}` : " (index/full)";
    return input.path ? `${name} ${input.path}${range}` : complete ? name : "";
  }
  if (name === "read_file_binary") return input.path ? `${name} ${input.path} (binary)` : complete ? name : "";
  if (name === "Read") return input.file_path ? `Read ${input.file_path}:${input.symbol ?? `${input.start_line}..${input.end_line}`}` : complete ? name : "";
  if (name === "sed_lines") return input.path ? `${name} ${input.path}:${input.start_line ?? 1}..${input.end_line ?? ""}` : complete ? name : "";
  if (name === "edit_diff") return input.path ? `${name} ${input.path}${input.occurrence === "all" ? " (occurrence=all)" : ""}` : complete ? name : "";
  if (["write_diff", "delete_file", "review_diff"].includes(name)) return input.path ? `${name} ${input.path}` : complete ? name : "";
  if (name === "move_file") return (input.from_path ?? input.fromPath) && (input.to_path ?? input.toPath) ? `${name} ${input.from_path ?? input.fromPath} -> ${input.to_path ?? input.toPath}` : complete ? name : "";
  if (["git_status", "git_diff"].includes(name)) return complete ? name : "";
  if (name === "commit_changes") return typeof input.message === "string" ? `${name} ${JSON.stringify(input.message)}` : complete ? name : "";
  if (name === "push_commit") return typeof input.commit_sha === "string" ? `${name} ${input.commit_sha.slice(0, 12)}` : complete ? name : "";
  if (name === "lookup_schema") return [name, input.schema_id ?? input.task ?? input.intent ?? "catalog"].filter(Boolean).join(" ");
  if (name === "select_code_graph_candidates" || name === "search_code") return [name, typeof input.query === "string" ? JSON.stringify(input.query.slice(0, 80)) : "", input.kind ? `kind=${input.kind}` : ""].filter(Boolean).join(" ");
  if (name === "query_review") return [name, input.action, input.kind, input.id].filter(Boolean).join(" ");
  return complete ? name : "";
}

// Business purpose: formats completed Forge tool outcomes into concise, informative metrics for the Agent Activity monitor panel.
// Technical description: extracts line counts, file/entry totals, match counts, exit codes, commit SHAs, and duration from normalized tool results without exposing source code.
export function formatForgeToolActivitySummary(rawName, rawInput, status, result = {}, durationMs, errorCode) {
  const name = String(rawName ?? "").replace(/^mcp__forge__/, "");
  const commandText = formatForgeToolCommand(name, rawInput, true) || name;
  const details = [];
  if (status !== "started" && result && typeof result === "object") {
    if (typeof result.total_lines === "number") details.push(`${result.total_lines} lines`);
    else if (typeof result.stdout_lines === "number") details.push(`${result.stdout_lines} lines`);
    if (typeof result.total === "number") details.push(`${result.total} entries`);
    else if (typeof result.files === "number") details.push(`${result.files} files`);
    else if (typeof result.matches === "number") details.push(`${result.matches} matches`);
    else if (typeof result.count === "number") details.push(`${result.count} results`);
    if (typeof result.changed_files === "number") details.push(`${result.changed_files} changed files`);
    if (typeof result.commit_sha === "string") details.push(`sha=${result.commit_sha.slice(0, 12)}`);
    else if (typeof result.sha256 === "string") details.push(result.sha256.slice(0, 19));
    if (typeof result.exit_code === "number") details.push(`exit=${result.exit_code}`);
    if (typeof result.status === "string" && !["working", "success", "failed"].includes(result.status)) details.push(`status=${result.status}`);
  }
  if (errorCode) details.push(errorCode);
  if (status !== "started" && Number.isFinite(durationMs)) details.push(`${durationMs}ms`);
  const suffix = details.length ? ` (${details.join(", ")})` : "";
  return `Forge tool ${name} ${status}: ${commandText}${suffix}`;
}
