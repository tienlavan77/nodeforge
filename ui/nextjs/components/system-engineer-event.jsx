// Displays ordered public reply blocks, with collapsible commands and safely rendered agent text.
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationResponseReveal } from "./conversation-response-reveal.jsx";

// Renders reply snapshots in native event order without command output or duplicate message wrappers.
export function SystemEngineerEvent({ value, onMarkdownOpen }) {
  if (value?.type === "conversation_turn") return <>{value.entries.map((entry) => entry.type === "text"
    ? <ConversationResponseReveal key={entry.id} text={entry.text} contentType={value.content_type ?? "text/plain"} onMarkdownOpen={onMarkdownOpen} />
    : <SystemEngineerEvent key={entry.id} value={entry} />)}</>;
  const text = systemEngineerCommandText(systemEngineerEventText(value));
  return text ? <details className="system-engineer-command" open><summary><span className="system-engineer-command-dot" aria-hidden="true" />RAN</summary><pre className="system-engineer-event-value">{text}</pre></details> : null;
}

// Shows the quoted shell payload instead of its CLI launcher, without changing stored or executed commands.
// Only whole quoted commands are unwrapped: quotes inside environment assignments or arguments stay intact.
export function systemEngineerCommandText(command) {
  const text = command.trim();
  const payload = text.replace(/^(?:(?:\/[^\s/]+)*\/)?(?:bash|sh|zsh|dash|ksh)\s+-(?:lc|cl|c)\s+/, "");
  const singleQuoted = payload.match(/^'([^']*)'$/s);
  if (singleQuoted) return singleQuoted[1];
  const doubleQuoted = payload.match(/^"((?:\\[\s\S]|[^"\\])*)"$/);
  if (doubleQuoted) return doubleQuoted[1].replace(/\\(["\\$`])|\\\n/g, (_match, escaped) => escaped ?? "");
  return command;
}

// Presents only a command record. Historic output-bearing records are deliberately reduced too.
export function systemEngineerEventText(value) {
  if (!value || typeof value !== "object") return eventContent(value);
  if (value.type?.startsWith("item.")) return systemEngineerEventText(value.item);
  if (value.type === "conversation_turn") return value.entries.map((entry) => entry.text ?? entry.command ?? "").join("\n");
  if (value.type === "command_execution") return value.command ?? "";
  return "";
}

// Keeps arbitrary tool data intact while extracting readable text blocks from provider output.
// Structured tool arguments or results use JSON only when there is no textual representation.
function eventContent(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(eventContent).join("\n");
  if (typeof value === "object" && ["text", "tool_use", "server_tool_use", "tool_result", "web_search_tool_result"].includes(value.type)) return systemEngineerEventText(value);
  return JSON.stringify(value, null, 2);
}
