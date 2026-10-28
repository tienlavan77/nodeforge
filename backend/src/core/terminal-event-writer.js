// Projects persisted runtime events into concise operator results. Successful
// cache/checkpoint bookkeeping and duplicate SDK envelopes stay in JSON logs;
// errors, agent handoffs and explicit waiting/retry states remain visible.
import { formatTerminalLine, terminalActor, terminalResult, terminalText } from "./terminal-log-format.js";

/** Lists duplicate or routine events that have an authoritative result line
 * elsewhere; suppression never removes their persisted checkpoint evidence. */
const QUIET = new Set(["supervisor.agent_tool_event", "owner.sdk_route", "owner.message", "owner.sdk_request_completed", "review.sdk_completed",
  "ticket.file_claims_released", "ticket.context_manifest_synced", "ticket.change_written", "supervisor.blocker_triage_finished"]);

/** Creates a bounded identity and wait-state view per logger. Project plus
 * agent keys prevent parallel tickets from borrowing another actor's name. */
export function createTerminalEventWriter(output) {
  const identities = new Map(), waiting = new Map(), receipts = new Map();
  return (entry) => {
    const payload = entry.payload ?? {};
    const key = `${entry.project_id ?? ""}:${payload.agent_id ?? ""}`;
    const identity = { ...identities.get(key), ...Object.fromEntries(["agent_id", "agent_name", "agent_role", "role", "stage"].filter((field) => payload[field] !== undefined).map((field) => [field, payload[field]])) };
    identity.agent_role = payload.agent_role ?? payload.role ?? payload.stage ?? identity.agent_role;
    if (payload.agent_id) remember(identities, key, identity);
    if (entry.level === "debug" || payload.terminal_suppressed || ["started", "working"].includes(entry.status)) return;
    const receiptKey = `${entry.project_id ?? ""}:${entry.correlation_id ?? entry.task_id}:${payload.agent_id}:${payload.tool}`;
    if (["forge.tool_success", "forge.tool_failed"].includes(entry.event_name)) remember(receipts, receiptKey, [...(receipts.get(receiptKey) ?? []), entry.status].slice(-32));
    if (entry.event_name === "supervisor.agent_tool_event") {
      const pending = receipts.get(receiptKey) ?? [], index = pending.indexOf(entry.status);
      if (index >= 0) { pending.splice(index, 1); return; }
      if (entry.status !== "failed") return;
    }
    const result = terminalResult(entry);
    if (["SUCCESS", "INFO"].includes(result) && (QUIET.has(entry.event_name) || entry.event_name?.startsWith("code_cache."))) return;
    const errorCode = entry.error_code ?? payload.error_code ?? payload.error?.code;
    const fields = toolFacts(payload);
    const message = payload.tool ? `${payload.tool}${fields ? `; ${fields}` : ""}` : `${entry.message}${fields ? `; ${fields}` : ""}`;
    const detail = errorCode ? `${errorCode}: ${message}` : message;
    const taskId = entry.ticket_id ?? (/^(?:TICKET|TASK)-/.test(entry.task_id ?? "") ? entry.task_id : null);
    const scope = `${entry.project_id ?? ""}:${taskId ?? entry.conversation_id ?? entry.correlation_id ?? ""}`;
    if (result === "WAIT") {
      const signature = `${entry.event_name}:${detail}`;
      if (waiting.get(scope) === signature) return;
      remember(waiting, scope, signature);
    } else waiting.delete(scope);
    output?.write?.(`${formatTerminalLine({ timestamp: entry.timestamp, actor: terminalActor(identity), message: detail, result,
      projectId: entry.project_id, taskId, conversationId: taskId ? null : entry.conversation_id,
      correlationId: taskId || entry.conversation_id ? null : entry.correlation_id })}\n`);
  };
}

/** Bounds process-local display metadata without affecting durable agent or
 * ticket ownership; evicted entries can be learned again from later events. */
function remember(map, key, value) {
  if (map.size >= 2000 && !map.has(key)) map.delete(map.keys().next().value);
  map.set(key, value);
}

/** Selects useful tool receipts while keeping arbitrary source/command output
 * out of the terminal and retaining failure identity before display truncation. */
function toolFacts(payload) {
  const result = payload.result ?? {}, verification = result.verification ?? {};
  const errorMessage = payload.error_message ?? (typeof payload.error === "string" ? payload.error : payload.error?.message);
  return [payload.path && `path=${terminalText(payload.path)}`, Number.isFinite(payload.duration_ms) && `duration=${payload.duration_ms}ms`,
    errorMessage && `error=${terminalText(errorMessage).slice(0, 240)}`,
    Number.isInteger(payload.checks) && `checks=${payload.checks}`, Number.isInteger(payload.passed) && `passed=${payload.passed}`, Number.isInteger(payload.failed) && `failed=${payload.failed}`,
    Number.isInteger(payload.findings_count) && `findings=${payload.findings_count}`,
    payload.verdict && `verdict=${terminalText(payload.verdict)}`,
    Number.isInteger(result.count) && `results=${result.count}`, Number.isInteger(result.stdout_lines) && `lines=${result.stdout_lines}`,
    Number.isInteger(result.exit_code) && `exit=${result.exit_code}`, result.commit_sha && `sha=${terminalText(result.commit_sha).slice(0, 12)}`,
    Number.isInteger(result.changed_files) && `files=${result.changed_files}`, result.branch && `branch=${terminalText(result.branch)}`,
    result.job_id && `job=${terminalText(result.job_id)}`, Number.isInteger(result.passed) && `passed=${result.passed}`, Number.isInteger(result.failed) && `failed=${result.failed}`,
    (verification.status ?? result.status) && `status=${terminalText(verification.status ?? result.status)}`,
    Number.isInteger(payload.retry_after_ms) && `retry_after=${payload.retry_after_ms / 1000}s`].filter((value) => value !== false && value !== undefined && value !== null && value !== "").join("; ");
}
