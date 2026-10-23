<!-- Documents native CLI SDK event contracts and the durable, ordered System Engineer reply used for owner conversations. -->
# System Engineer SDK transcript

## Contract sources

The implementation targets the installed SDK versions, not an inferred generic LLM stream:

- `@openai/codex-sdk` 0.154.0: `README.md` (Streaming responses) and `dist/index.d.ts` (`ThreadEvent`, `CommandExecutionItem`, `AgentMessageItem`). The SDK wraps CLI JSONL; `runStreamed()` returns ordered item lifecycle events.
- `@anthropic-ai/claude-agent-sdk` 0.3.263: `sdk.d.ts` (`SDKPartialAssistantMessage`, `SDKAssistantMessage`, `SDKUserMessage`, `includePartialMessages`). Partial messages wrap Messages API content-block events. Complete assistant messages and tool results are also delivered.

Online documentation could not be retrieved in the implementation environment. These are the official package sources actually installed in `backend/node_modules`.

## Normalization

| Native event | Transcript behavior |
| --- | --- |
| Codex `item.started/updated/completed`, `agent_message` | Replace the text block identified by `item.id`, in its initial position. |
| Codex command item lifecycle | Keep command identity and status; never retain `aggregated_output`. |
| Claude `message_start` | Establish the message ID and reset content-block assembly for that message. |
| Claude text block start/delta | Append deltas to the block identified by message ID and block index. |
| Claude tool input JSON deltas | Assemble complete JSON at block stop; retain a bounded command with the tool-use ID. |
| Claude complete assistant blocks | Reconcile with partial blocks; do not duplicate streamed text or commands. |
| Claude `tool_result` | Update the command state by `tool_use_id`, without retaining output. |
| Reasoning, initialization, child-agent frames | Exclude from the owner-facing reply. |
| SDK return or failure | Finalize the transcript; use returned text only if no public text block exists. |

Text is not assigned to the preceding command. The native event order supplies placement, not a fabricated causal relationship.

## One reply, live and persisted

`sdk_event.type = conversation_turn` carries ordered `entries`, the provider `run_id`, a revision and status. Entries keep the timestamp and ID assigned on first appearance; later snapshots replace content without moving the block. Command text is capped at 250 words only for display/storage, never for execution.

The communication store uses one canonical identity scoped by project, conversation, execution correlation and agent. Updates replace that indexed record. The final legacy `.message.received` supplies model-history text on the same record instead of inserting a second reply. The existing JSONL backing file retains append-only record versions for recovery; the conversation index and API expose one message, not those versions as separate messages.

Continue retains prior run entries and appends entries with new run-scoped IDs. A different human execution has a different correlation and therefore a different message. Existing historical records are not deleted or rewritten.

The SSE publisher persists before publishing and sends the canonical revision/entries. UI snapshots use `agent:<correlation_id>` as the stable card key; stale replay cannot replace newer snapshots. Legacy concatenated text deltas and completion cannot overwrite an active transcript.

## Presentation

One assistant card contains one agent-name/time header and all ordered blocks. Commands use initially expanded native `details` elements with a round dot and `RAN` label, without a border or background. Clicking the label still collapses or expands the command, both live and in saved history. Command font is 12px; outer padding is zero, with 15px left padding only on the expanded command value. Fully quoted commands and quoted shell-launcher payloads are unwrapped for display only; quotes inside bare commands, including environment assignments, are preserved. Text uses the existing safe Markdown renderer.
