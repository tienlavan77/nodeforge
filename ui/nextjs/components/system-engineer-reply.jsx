// Renders the whole System Engineer execution as one assistant message during live
// delivery and replay. The agent name and time appear once above ordered public blocks.
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { SystemEngineerEvent } from "./system-engineer-event.jsx";

// Keeps the same card and block identities while provider snapshots extend the reply.
export function SystemEngineerReply({ message, displayMessageTime, onMarkdownOpen }) {
  return <article className="claude-message is-agent" data-agent-turn={message.correlation_id}>
    <div className="claude-message-meta"><span>{message.nickname ?? "System Engineer"}</span><time dateTime={message.timestamp}>{displayMessageTime(message.timestamp)}</time></div>
    <SystemEngineerEvent value={message.se_event} onMarkdownOpen={onMarkdownOpen} />
  </article>;
}
