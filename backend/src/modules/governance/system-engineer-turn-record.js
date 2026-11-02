// Keeps an owner's System Engineer reply as one durable communication record per
// project, conversation, agent and execution, including continued provider sessions.
import { createHash } from "node:crypto";
import { isIdeaSummaryResponse } from "./conversation-plan-trigger.js";

// Resolves the canonical reply identity without merging different owners' requests or agent runs.
export function systemEngineerTurnRecord(message, getById) {
  const payload = message.payload ?? {};
  const snapshot = payload.agent_role === "system_engineer" && payload.sdk_event?.type === "conversation_turn";
  const completed = message.message_type?.endsWith(".message.received");
  if ((!snapshot && !completed) || !message.conversation_id || !message.correlation_id) return null;
  const agentId = snapshot ? payload.agent_id : message.sender.id;
  const identity = [message.project_id, message.conversation_id, message.correlation_id, agentId];
  const id = `SE-TURN-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  const previous = getById(id);
  if (!snapshot) return previous ? { previous, stored: { ...previous, payload: { ...previous.payload, text: payload.text, content_type: payload.content_type } } } : null;
  const before = previous?.payload.sdk_event;
  if (before?.run_id === payload.sdk_event.run_id && before.revision >= payload.sdk_event.revision) return { previous, stored: previous };
  const entries = new Map((before?.entries ?? []).map((entry) => [entry.id, entry]));
  for (const entry of payload.sdk_event.entries) entries.set(entry.id, entry);
  const mergedEntries = [...entries.values()];
  const turnText = mergedEntries.filter((entry) => entry.type === "text" && typeof entry.text === "string").map((entry) => entry.text).join("\n");
  const resolvedIdea = typeof previous?.payload?.is_idea === "boolean"
    ? previous.payload.is_idea
    : (typeof payload.is_idea === "boolean" ? payload.is_idea : (isIdeaSummaryResponse({ agentText: turnText }) ? true : undefined));
  return { previous, stored: { ...message, id, timestamp: previous?.timestamp ?? message.timestamp,
    payload: { ...payload, ...(typeof resolvedIdea === "boolean" ? { is_idea: resolvedIdea } : {}), sdk_sequence: (previous?.payload.sdk_sequence ?? 0) + 1,
      sdk_event: { ...payload.sdk_event, entries: mergedEntries } } } };
}
