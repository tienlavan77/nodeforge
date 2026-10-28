// Presents provider sessions as one result instead of raw SDK lifecycle noise.
// Transport warnings stay visible immediately; tool receipts and checkpoint
// events continue through their existing owning services without duplication.
import { formatTerminalLine, terminalActor, terminalText } from "../../core/terminal-log-format.js";

/** Builds a provider-neutral session summary using the configured profile and
 * trusted execution context, never provider-generated actor names or prompts. */
export function createSdkTerminalLog({ profile, correlationId, context = {}, output = process.stdout, credential, now = Date.now }) {
  const started = now();
  let failure, lastWarning, closed = false;
  // Writes bounded diagnostics with the same suffix and actor layout as Forge.
  const write = (message, result) => output?.write?.(`${formatTerminalLine({ timestamp: new Date(now()).toISOString(), actor: terminalActor(profile),
    message, result, correlationId, taskId: /^(?:TICKET|TASK)-/.test(context.task_id ?? "") ? context.task_id : null,
    conversationId: context.conversation_id, projectId: context.project_id, secrets: [credential] })}\n`);
  return {
    // Records terminal failures for the final result; transient SDK transport
    // events remain warnings rather than claims that Node scheduled a retry.
    event(event) {
      if (event.type === "turn.failed") failure = event.error ?? { message: "SDK turn failed." };
      if (event.type !== "error") return;
      const warning = terminalText(event.message ?? event.error?.message ?? "SDK transport error.", [credential]);
      if (warning !== lastWarning) { lastWarning = warning; write(`sdk.transport ${warning}`, "WARN"); }
    },
    // Emits exactly one session outcome. SDK success never means the ticket is
    // DONE: verification and independent review still belong to orchestration.
    close(error) {
      if (closed) return;
      closed = true;
      const cause = error ?? failure;
      const stopped = cause?.code === "TICKET_STOPPED" || cause?.code === "OWNER_EXECUTION_STOPPED";
      write(`sdk.completed provider=${profile.provider ?? "unknown"}; model=${profile.model ?? "default"}; duration=${now() - started}ms${cause ? `; ${cause.code ?? "SDK_FAILED"}: ${cause.message ?? cause}` : ""}`, stopped ? "STOP" : cause ? "FAIL" : "SUCCESS");
    }
  };
}
