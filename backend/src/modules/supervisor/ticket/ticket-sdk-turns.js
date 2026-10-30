/** Continues confirmed successful SDK turns within one governed Coder execution.
 * Session identity, tool governance and checkpoint state stay attached to the
 * existing ticket; only governed completion tools can finish or escalate work. */
import { ConfigurationError } from "../../../shared/errors.js";
import { createFileService } from "../../../infrastructure/filesystem/file-service.js";
import { createAgentExchangeStorage } from "../../governance/agent-exchange-storage.js";
import { assertTicketExecutionCompleted } from "../nodeforge-task-sdk-events.js";
import { saveProgressCheckpoint } from "./ticket-checkpoint-writer.js";
import { parseTicketWorkProgress, ticketWorkContinuationPrompt, TICKET_WORK_PROGRESS_PROMPT } from "./ticket-work-progress.js";
import { buildCompactedRolloverPrompt, extractTurnInputTokens, shouldRolloverSdkSession } from "./ticket-context-compaction.js";
import { createTicketDirectiveInbox, sanitizeDeliveredDirectives } from "./ticket-directive-inbox.js";

/** Resumes after typed phase yields or a legacy narrative final answer. Unknown
 * provider outcomes and real tool failures keep their original recovery path.
 * No-progress detection uses tool receipts, never a fixed continuation count. */
export async function runTicketSdkTurns({ executeTurn, readToolEvents, prompt, selected, request, resumeState, checkpoints, projectRoot, projectLogger = () => {}, priorTools = [], labMode = false, directiveInbox = null }) {
  const missingCode = selected.provider === "codex" ? "CODEX_MCP_TOOL_CALLS_MISSING" : "CLAUDE_MCP_TOOL_CALLS_MISSING";
  const toolEvents = [];
  const basePrompt = prompt;
  let nextPrompt = selected.role === "coder" && !labMode ? `${prompt}\n\n${TICKET_WORK_PROGRESS_PROMPT}` : prompt;
  let receipts = resumeState.sdkTurnProgress?.receipt_position ?? 0;
  let lastValid = null; let lastCorrection = null; let storage;
  const inbox = directiveInbox ?? (projectRoot && request?.project_id && request?.task_id
    ? createTicketDirectiveInbox({ fileService: createFileService({ projectRoot, role: "system_engineer" }), projectId: request.project_id, projectRoot, projectLogger })
    : null);
  for (;;) {
    request.abortSignal?.throwIfAborted();
    const result = await executeTurn(nextPrompt);
    request.abortSignal?.throwIfAborted();
    const events = readToolEvents(result);
    toolEvents.push(...events);
    receipts += events.filter((event) => event.status !== "failed").length;
    try {
      assertTicketExecutionCompleted(toolEvents, { labMode, missingCode, priorTools });
      return { result, toolEvents };
    } catch (error) {
      const sessionId = selected.provider === "codex" ? resumeState.threadId : resumeState.sessionId;
      if (labMode || selected.role !== "coder" || result.turn_completed !== true || (!sessionId && !Array.isArray(result.history))
        || !["AGENT_REPORT_MISSING", missingCode].includes(error.code)
        || toolEvents.some((event) => ["report_done", "commit_changes"].includes(event.tool ?? event.name) && event.status === "failed")) throw error;
    }
    let progress; let correction;
    try { progress = parseTicketWorkProgress(result.text, request.payload?.agent_exchange); }
    catch (error) { correction = error.code ?? "WORK_PROGRESS_SCHEMA_REQUIRED"; }
    const drained = inbox && request?.task_id
      ? await inbox.drainPending({ taskId: request.task_id, executionId: request.payload?.execution_id ?? null, turnCount: resumeState.turnCount, receiptPosition: receipts })
      : { directives: [], pauseRequested: false };
    if (drained.directives.length) {
      resumeState.deliveredDirectives = sanitizeDeliveredDirectives([...(resumeState.deliveredDirectives ?? []), ...drained.directives]);
    }
    if (drained.pauseRequested) {
      resumeState.sdkTurnProgress = { status: "paused_by_directive", next_action: progress?.payload.next_action ?? null,
        receipt_position: receipts, last_completed_turn: resumeState.turnCount };
      await saveProgressCheckpoint(checkpoints, resumeState, { task_id: request.task_id, correlation_id: request.correlation_id,
        agent_id: selected.agent_id, provider: selected.provider, changed_paths: [...resumeState.changedPaths], status: "paused_by_directive" });
      projectLogger({ event_name: "supervisor.sdk_turn_paused_by_directive", level: "info", status: "paused", task_id: request.task_id, correlation_id: request.correlation_id,
        message: "Ticket execution gracefully paused at turn boundary by directive.", payload: { agent_id: selected.agent_id, provider: selected.provider, ...resumeState.sdkTurnProgress } });
      throw Object.assign(new ConfigurationError("Ticket execution gracefully paused at turn boundary by directive."), { code: "DIRECTIVE_PAUSE_REQUESTED" });
    }
    if (!drained.directives.length && (progress ? lastValid !== null && receipts <= lastValid : lastCorrection !== null && receipts <= lastCorrection))
      throw Object.assign(new ConfigurationError("Coder yielded again without new successful tool progress; the same session and checkpoint are retained for Resume."), { code: "AGENT_PROGRESS_STALLED" });
    if (progress) lastValid = receipts; else lastCorrection = receipts;
    let progressRef;
    if (progress?.message_id) {
      storage ??= createAgentExchangeStorage({ fileService: createFileService({ projectRoot, role: "system_engineer" }), projectLogger });
      progressRef = await storage.save(progress);
    }
    const rollover = shouldRolloverSdkSession({ result, progress, resumeState, threshold: request?.payload?.compaction_token_threshold });
    const previousSessionId = resumeState.sessionId ?? resumeState.threadId ?? null;
    const rolloverCount = (resumeState.sdkTurnProgress?.compaction_rollover_count ?? 0) + (rollover ? 1 : 0);
    if (rollover) {
      resumeState.sessionRolledOver = true;
      resumeState.sessionId = null;
      resumeState.threadId = null;
    }
    resumeState.sdkTurnProgress = {
      status: progress?.payload.status ?? "response_required",
      next_action: progress?.payload.next_action ?? null,
      receipt_position: receipts,
      last_completed_turn: resumeState.turnCount,
      ...(progressRef ? { message_ref: progressRef.ref } : {}),
      ...(rollover ? { rolled_over_from: previousSessionId, compaction_rollover_count: rolloverCount } : rolloverCount ? { compaction_rollover_count: rolloverCount } : {})
    };
    await saveProgressCheckpoint(checkpoints, resumeState, { task_id: request.task_id, correlation_id: request.correlation_id,
      agent_id: selected.agent_id, provider: selected.provider, changed_paths: [...resumeState.changedPaths], ...(rollover ? { session_id: null, thread_id: null } : {}) });
    request.abortSignal?.throwIfAborted();
    if (rollover) {
      projectLogger({ event_name: "supervisor.sdk_context_compacted", level: "info", status: "success", task_id: request.task_id, correlation_id: request.correlation_id,
        message: "Rolled over SDK session at phase boundary with compacted receipt digest.",
        payload: { agent_id: selected.agent_id, provider: selected.provider, mode: "session_rollover", previous_session_id: previousSessionId, input_tokens: extractTurnInputTokens(result), receipt_position: receipts, compaction_rollover_count: rolloverCount } });
    }
    projectLogger({ event_name: "supervisor.sdk_turn_continuing", level: "info", status: "started", task_id: request.task_id, correlation_id: request.correlation_id,
      message: progress ? "Agent reported phase progress; continuing the same SDK session from its checkpoint." : "Agent turn ended before ticket completion; requesting structured progress in the same SDK session.",
      payload: { agent_id: selected.agent_id, provider: selected.provider, ...resumeState.sdkTurnProgress, ...(correction ? { correction } : {}) } });
    nextPrompt = rollover
      ? buildCompactedRolloverPrompt({ basePrompt, progress, resumeState, directives: drained.directives })
      : ticketWorkContinuationPrompt(progress, resumeState, drained.directives);
  }
}
