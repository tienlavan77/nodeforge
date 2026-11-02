// Renders the whole System Engineer execution as one assistant message during live
// delivery and replay. The agent name and time appear once above ordered public blocks.
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { SystemEngineerEvent } from "./system-engineer-event.jsx";

// Keeps the same card and block identities while provider snapshots extend the reply.
import { ConversationAgentMessageActions } from "./conversation-message-actions.jsx";

import { ConversationResponseReveal } from "./conversation-response-reveal.jsx";
import { systemEngineerEventText } from "./system-engineer-event.jsx";

// Business purpose: groups all System Engineer commands and text from one correlated turn into one chat card so command records cannot fragment the agent reply.
// Technical description: iterates transcript messages in event order, leaving explicit conversation_turn snapshots intact while grouping correlated agent/SE messages into a timeline array.
export function groupAgentTurnMessages(messages) {
  const groups = new Map();
  const output = [];
  for (const message of messages) {
    if (message.se_event?.type === "conversation_turn") { output.push(message); continue; }
    const agentTurn = message.correlation_id && (message.from === "agent" || message.se_event);
    if (!agentTurn) { output.push(message); continue; }
    const key = `agent-turn:${message.correlation_id}`;
    let group = groups.get(key);
    if (!group) {
      group = { ...message, id: key, stream_key: key, from: "agent", se_event: null, text: "", timeline: [] };
      groups.set(key, group); output.push(group);
    }
    group.timeline.push(message);
  }
  return output;
}

// Business purpose: keeps the grouped timeline card labelled with the real agent identity rather than a command-specific suffix.
// Technical description: finds the first nickname in message.timeline and strips any trailing " · command" suffix.
export function transcriptAgentName(message) {
  const source = message.timeline?.find((entry) => entry.nickname)?.nickname ?? "Claude Agent";
  return source.replace(/ · command$/, "");
}

// Business purpose: renders each entry in a grouped System Engineer timeline card with individual copy, share, and Idea actions.
// Technical description: maps over timeline entries, wrapping conversation_turn and text replies in ConversationAgentMessageActions while preserving each entry's original message identity.
export function SystemEngineerTimelineEntries({ timeline, client, projectId, onToggleIdea, onMarkdownOpen, onReveal }) {
  return timeline.map((entry) => entry.se_event ? (
    entry.se_event.type === "conversation_turn" ? (
      <ConversationAgentMessageActions key={entry.stream_key ?? entry.id} message={{ ...entry, from: entry.from ?? "agent", text: entry.text || systemEngineerEventText(entry.se_event) }} client={client} projectId={projectId} onToggleIdea={onToggleIdea}>
        <SystemEngineerEvent value={entry.se_event} onMarkdownOpen={onMarkdownOpen} />
      </ConversationAgentMessageActions>
    ) : (
      <SystemEngineerEvent key={entry.stream_key ?? entry.id} value={entry.se_event} onMarkdownOpen={onMarkdownOpen} />
    )
  ) : (
    <ConversationAgentMessageActions key={entry.stream_key ?? entry.id} message={{ ...entry, from: entry.from ?? "agent" }} client={client} projectId={projectId} onToggleIdea={onToggleIdea}>
      <ConversationResponseReveal text={entry.text} contentType={entry.content_type ?? "text/markdown"} reveal={entry.reveal === true} onMarkdownOpen={onMarkdownOpen} onReveal={onReveal} />
    </ConversationAgentMessageActions>
  ));
}

export function SystemEngineerReply({ message, displayMessageTime, onMarkdownOpen, client, projectId, onToggleIdea }) {
  return <article className="claude-message is-agent" data-agent-turn={message.correlation_id}>
    <div className="claude-message-meta"><span>{message.nickname ?? "System Engineer"}</span><time dateTime={message.timestamp}>{displayMessageTime(message.timestamp)}</time></div>
    <ConversationAgentMessageActions message={message} client={client} projectId={projectId} onToggleIdea={onToggleIdea}>
      <SystemEngineerEvent value={message.se_event} onMarkdownOpen={onMarkdownOpen} />
    </ConversationAgentMessageActions>
  </article>;
}
