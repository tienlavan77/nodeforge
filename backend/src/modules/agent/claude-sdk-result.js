/** Selects the terminal Claude SDK result instead of combining discovery
 * narration with the final agent response. Structured callers receive only the
 * SDK's structured output, and terminal failures never become success text. */

/** Retains the SDK outcome and error subtype for recovery to distinguish a
 * completed failed turn from a stream whose completion was never confirmed. */
function resultError(code, message, result, outcome = "failed") {
  return Object.assign(new Error(message), { code, provider_outcome: outcome, retry_safe: false,
    status: result?.api_error_status ?? undefined, sdk_subtype: result?.subtype });
}

/** Uses the explicit turn-complete result as authoritative. The last assistant
 * text fallback supports older plain-text streams only and excludes subagents;
 * it cannot satisfy an explicitly requested structured response. */
export function claudeSdkResult(messages, { structured = false } = {}) {
  const result = messages.findLast((message) => message.type === "result");
  if (result) {
    if (result.is_error || result.subtype !== "success")
      throw resultError("CLAUDE_SDK_RESULT_ERROR", `Claude Code returned ${result.subtype ?? "an error result"}: ${result.errors?.join("; ") || result.result || "No result details."}`, result);
    if (result.structured_output !== undefined) return { text: JSON.stringify(result.structured_output), structured_output: result.structured_output };
    if (structured) throw resultError("CLAUDE_SDK_STRUCTURED_OUTPUT_MISSING", "Claude SDK completed without the requested structured_output.", result);
    return { text: typeof result.result === "string" ? result.result : "" };
  }
  if (structured) throw resultError("CLAUDE_SDK_RESULT_MISSING", "Claude SDK stream ended without a terminal structured result; provider completion is unconfirmed.", null, "unknown");
  const assistant = messages.findLast((message) => message.type === "assistant" && !message.parent_tool_use_id
    && message.message?.content?.some((block) => block.type === "text" && typeof block.text === "string"));
  return { text: (assistant?.message.content ?? []).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n").trim() };
}
