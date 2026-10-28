// Gives operators one result-oriented terminal format across agents and services.
// Structured logs retain their original events; this module only selects safe,
// bounded display fields and never interprets agent prose as execution state.

/** Maps persisted role identities to the short labels used in operator logs. */
const ROLES = { system_engineer: "SE", architecture_manager: "AM", sprint_leader: "SL", coder: "Coder", reviewer: "Reviewer", node: "Node" };

/** Removes control sequences and credentials from one display field without
 * allowing multiline provider errors to impersonate additional terminal events. */
export function terminalText(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[REDACTED]");
  // eslint-disable-next-line no-control-regex -- Strip terminal control sequences from untrusted provider text.
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex -- Keep one printable terminal line, including after ANSI removal.
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ")
    .replace(/(?:https?|wss?):\/\/\S+/gi, "[URL]")
    .replace(/\b(Bearer\s+|(?:api[_-]?key|token|authorization)\s*[=:]\s*)\S+/gi, "$1[REDACTED]").trim();
}

/** Names the actual actor from trusted event metadata, keeping Node's work
 * separate from the agent requesting verification or a handoff. */
export function terminalActor(identity = {}) {
  const role = ROLES[identity.agent_role ?? identity.role ?? identity.stage];
  const name = terminalText(identity.agent_name ?? identity.agent_id);
  return role ? role === "Node" ? role : `${role}${name ? `/${name}` : ""}` : name ? `Agent/${name}` : "Node";
}

/** Chooses a suffix from structured event state, so a recoverable tool error
 * does not announce ticket completion or invent a retry schedule. */
export function terminalResult(entry) {
  const payload = entry.payload ?? {}, name = entry.event_name ?? "";
  if (/retry_scheduled$/.test(name) || ["retry", "retrying", "retry_wait"].includes(entry.status)) return "RETRY";
  if (["paused", "stopped", "cancelled"].includes(entry.status) || entry.error_code === "TICKET_STOPPED") return "STOP";
  if (["pending", "blocked", "waiting", "queued", "needs_human_review"].includes(entry.status)) return "WAIT";
  if (entry.level === "error" || entry.error_code || payload.error_code || payload.error?.code || ["failed", "error", "invalid"].includes(entry.status)) return "FAIL";
  if (name === "task.completed" || name === "terminal_bridge.status_synced" && payload.to === "done") return "DONE";
  if (entry.level === "warn" || entry.status === "warn") return "WARN";
  return ["success", "completed", "passed", "valid", "approve", "request_changes"].includes(entry.status) ? "SUCCESS" : "INFO";
}

/** Creates one plain result line; service prefixes and ANSI colors belong to
 * the foreground renderer so saved logs remain readable outside a terminal. */
export function formatTerminalLine({ timestamp = new Date().toISOString(), actor = "Node", message, result = "INFO", projectId, taskId, conversationId, correlationId, secrets = [] }) {
  const time = new Date(timestamp).toISOString().slice(11, 19);
  const scope = [terminalText(projectId) || "-", taskId && !/^RUNTIME-|^TOOL-/.test(taskId) ? terminalText(taskId) : "-"];
  const context = [scope.some((value) => value !== "-") && `[${scope.join("|")}]`,
    conversationId && `conversation=${terminalText(conversationId)}`, correlationId && `run=${terminalText(correlationId)}`].filter(Boolean).join("; ");
  return `[${time}] [${terminalText(actor)}] ${terminalText(message, secrets).slice(0, 600)}${context ? `; ${context}` : ""} - ${result}`;
}

/** Collects small result facts shared by Coder and conversation tool events,
 * excluding source text, shell output, prompts and unrestricted tool arguments. */
export function terminalToolResult(tool, result = {}) {
  const value = result?.result ?? result;
  const stdout = typeof result?.stdout === "string" ? result.stdout : null;
  const checks = value?.breakdown ?? value?.checks;
  return {
    ...(typeof result?.status === "string" ? { status: result.status } : {}),
    ...(Number.isInteger(result?.exit_code) ? { exit_code: result.exit_code } : {}),
    ...(typeof result?.sha === "string" || typeof result?.commit_sha === "string" ? { commit_sha: result.sha ?? result.commit_sha } : {}),
    ...(typeof result?.job_id === "string" ? { job_id: result.job_id } : {}),
    ...(Number.isInteger(result?.changed_files) ? { changed_files: result.changed_files } : Array.isArray(result?.paths) ? { changed_files: result.paths.length } : {}),
    ...(typeof result?.branch === "string" ? { branch: result.branch } : {}),
    ...(Array.isArray(checks) ? { passed: checks.filter((check) => ["passed", "success"].includes(check.status) || check.exit_code === 0).length, failed: checks.filter((check) => check.status === "failed" || check.exit_code > 0).length } : {}),
    ...(["list_files", "search_text", "read_lines"].includes(tool) && stdout !== null ? { stdout_lines: stdout.split(/\r?\n/).filter(Boolean).length } : {}),
    ...(Array.isArray(result?.selected) || Array.isArray(result?.matches) || Array.isArray(result?.files) ? { count: (result.selected ?? result.matches ?? result.files).length } : {})
  };
}

/** Keeps lower-level service diagnostics in the audit trail while the owning
 * tool wrapper emits the single operator result, including on failures. */
export function terminalAuditLogger(logger) {
  return (entry) => logger?.({ ...entry, payload: { ...entry.payload, terminal_suppressed: true } });
}
