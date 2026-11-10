// Enforces mandatory delegated-first discovery policy, receipt validation, and controlled parent exceptions.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";

export const BROAD_DISCOVERY_TOOLS = Object.freeze([
  "search_tree",
  "list_files",
  "search_text",
  "select_code_graph_candidates"
]);

export const TARGETED_READ_TOOLS = Object.freeze([
  "read_file",
  "Read"
]);

export const GIT_INSPECTION_TOOLS = Object.freeze([
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_blame"
]);

export const DELEGATED_DISCOVERY_TOOLS = Object.freeze([
  ...BROAD_DISCOVERY_TOOLS,
  ...TARGETED_READ_TOOLS,
  ...GIT_INSPECTION_TOOLS
]);

export const ALLOWED_SUBAGENT_EXPLORATION_TOOLS = Object.freeze([
  "search_tree",
  "list_files",
  "search_text",
  "read_file",
  "Read"
]);

const FAKE_OBJECTIVE_PATTERNS = [
  /^do\s+discovery\.?$/i,
  /^discover(?:\s+code|\s+repo|\s+repository|\s+files)?\.?$/i,
  /^explore(?:\s+code|\s+repo|\s+repository|\s+files)?\.?$/i,
  /^read(?:\s+files|\s+code)?\.?$/i,
  /^check(?:\s+files|\s+code)?\.?$/i,
  /^search\.?$/i,
  /^test\.?$/i,
  /^todo\.?$/i,
  /^n\/a$/i,
  /^none$/i
];

const MANDATORY_RULE_FILE_PATTERN = /^(?:AGENTS\.md|(?:[A-Za-z0-9_.-]+\/)*AGENTS\.md|workflows\/agents\/[A-Za-z0-9_.-]+\/README\.md|ARCHITECTURE\.md|vocabulary\/glossary\.md)$/;

// Business purpose: validates that a subagent task objective is specific and non-trivial rather than a placeholder bypass.
// Technical description: rejects empty, overly short, or generic objectives such as "do discovery".
export function isMeaningfulDelegationObjective(objective) {
  if (typeof objective !== "string") return false;
  const trimmed = objective.trim();
  if (trimmed.length < 4) return false;
  if (FAKE_OBJECTIVE_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
  return /[A-Za-zÀ-ỹ0-9]{2,}/.test(trimmed);
}

// Business purpose: emits structured runtime telemetry for delegated discovery enforcement and lifecycle events.
// Technical description: forwards event payloads to projectLogger, project_logger, and logger.emit on the execution context when present.
export function emitDelegatedDiscoveryTelemetry(context = {}, eventName, status, message, payload = {}) {
  const timestamp = new Date().toISOString();
  const record = {
    timestamp,
    event_name: eventName,
    level: status === "rejected" || status === "failed" || status === "forbidden" ? "warn" : "info",
    status,
    message,
    task_id: context?.task_id ?? context?.correlation_id ?? null,
    correlation_id: context?.correlation_id ?? context?.execution_id ?? null,
    conversation_id: context?.conversation_id ?? context?.evidence_scope?.conversationId ?? null,
    source: "delegated-discovery-policy",
    ...(payload.error_code ? { error_code: payload.error_code } : {}),
    payload: {
      agent_id: context?.agent_identity?.agent_id ?? null,
      role: context?.agent_identity?.role ?? context?.evidence_scope?.role ?? null,
      execution_id: context?.execution_id ?? null,
      ...payload
    }
  };
  try {
    context?.projectLogger?.(record);
    context?.project_logger?.(record);
    context?.logger?.emit?.(record);
  } catch {
    // Telemetry emission must never break tool execution.
  }
}

// Business purpose: records a verified delegation receipt on the parent execution context when subagents are spawned.
// Technical description: stores delegation identity, execution/conversation scope, tasks, read_only_enforced flag, status, and expiry timestamp.
export function recordDelegationReceipt(context = {}, receiptInput = {}) {
  if (!context || typeof context !== "object") return null;
  const now = Date.now();
  const ttlMs = Number.isFinite(receiptInput.ttl_ms) && receiptInput.ttl_ms > 0 ? receiptInput.ttl_ms : 30 * 60 * 1000;
  const createdAt = receiptInput.created_at ?? new Date(now).toISOString();
  const expiresAt = receiptInput.expires_at ?? new Date(now + ttlMs).toISOString();
  const tasks = Array.isArray(receiptInput.tasks)
    ? receiptInput.tasks.map((task) => ({
        id: task.id,
        objective: task.objective,
        ...(Array.isArray(task.paths) ? { paths: [...task.paths] } : {})
      }))
    : [];
  const receipt = {
    delegation_id: String(receiptInput.delegation_id ?? context.execution_id ?? context.task_id ?? `DELEGATION-${now}`),
    conversation_id: context.conversation_id ?? context.evidence_scope?.conversationId ?? null,
    execution_id: context.execution_id ?? context.task_id ?? null,
    task_id: context.task_id ?? null,
    plan_id: context.evidence_scope?.planId ?? context.plan_id ?? null,
    handoff_id: context.evidence_scope?.handoffId ?? context.handoff_id ?? null,
    ticket_id: context.evidence_scope?.ticketId ?? context.task_id ?? null,
    status: receiptInput.status ?? "running",
    read_only_enforced: receiptInput.read_only_enforced !== false,
    fallback_to_parent: Boolean(receiptInput.fallback_to_parent),
    fallback_reason: receiptInput.fallback_reason ?? null,
    tasks,
    created_at: createdAt,
    expires_at: expiresAt
  };
  const existing = Array.isArray(context.delegation_receipts) ? context.delegation_receipts : [];
  const index = existing.findIndex((item) => item?.delegation_id === receipt.delegation_id);
  if (index >= 0) existing[index] = { ...existing[index], ...receipt };
  else existing.push(receipt);
  context.delegation_receipts = existing;
  if (receipt.fallback_to_parent) {
    context.subagent_fallback_to_parent = {
      fallback_to_parent: true,
      delegation_id: receipt.delegation_id,
      reason: receipt.fallback_reason ?? "All subagent providers/models failed; parent direct discovery authorized.",
      recorded_at: new Date().toISOString()
    };
  }
  return receipt;
}

// Business purpose: validates whether a candidate delegation receipt satisfies runtime scope, objective, status, and expiry rules.
// Technical description: checks conversation/execution binding, non-expired status, read_only_enforced flag, meaningful objectives, and optional target path scope.
export function validateDelegationReceipt(receipt, context = {}, targetPaths = []) {
  if (!receipt || typeof receipt !== "object") return { valid: false, reason: "MISSING_RECEIPT" };
  if (receipt.read_only_enforced !== true) return { valid: false, reason: "READ_ONLY_NOT_ENFORCED" };
  if (["cancelled", "expired", "failed"].includes(receipt.status) && !receipt.fallback_to_parent) {
    return { valid: false, reason: `INVALID_STATUS_${String(receipt.status).toUpperCase()}` };
  }
  if (!["pending", "queued", "accepted", "running", "completed", "partial_success", "fallback_to_parent"].includes(receipt.status)) {
    return { valid: false, reason: "UNKNOWN_STATUS" };
  }
  if (receipt.expires_at) {
    const expiry = Date.parse(receipt.expires_at);
    if (Number.isFinite(expiry) && expiry < Date.now()) {
      return { valid: false, reason: "DELEGATION_EXPIRED" };
    }
  }
  const ctxConv = context.conversation_id ?? context.evidence_scope?.conversationId ?? null;
  const ctxExec = context.execution_id ?? null;
  const ctxTask = context.task_id ?? null;
  const ctxPlan = context.evidence_scope?.planId ?? context.plan_id ?? null;
  const ctxHandoff = context.evidence_scope?.handoffId ?? context.handoff_id ?? null;
  const scopeMatched = Boolean(
    (ctxExec && receipt.execution_id && ctxExec === receipt.execution_id) ||
    (ctxConv && receipt.conversation_id && ctxConv === receipt.conversation_id) ||
    (ctxTask && receipt.task_id && ctxTask === receipt.task_id) ||
    (ctxPlan && receipt.plan_id && ctxPlan === receipt.plan_id) ||
    (ctxHandoff && receipt.handoff_id && ctxHandoff === receipt.handoff_id)
  );
  if (!scopeMatched && (ctxExec || ctxConv || ctxTask)) {
    return { valid: false, reason: "DELEGATION_SCOPE_MISMATCH" };
  }
  const tasks = Array.isArray(receipt.tasks) ? receipt.tasks : [];
  if (tasks.length === 0) return { valid: false, reason: "EMPTY_DELEGATION_TASKS" };
  if (tasks.some((task) => !isMeaningfulDelegationObjective(task?.objective))) {
    return { valid: false, reason: "INVALID_TASK_OBJECTIVE" };
  }
  const scopedTaskPaths = tasks.flatMap((task) => Array.isArray(task?.paths) ? task.paths : []).filter(Boolean);
  if (scopedTaskPaths.length > 0 && targetPaths.length > 0) {
    const pathCovered = targetPaths.every((target) => {
      const normalizedTarget = String(target).replace(/^\.\//, "").replace(/\/$/, "");
      if (!normalizedTarget || normalizedTarget === ".") return true;
      return scopedTaskPaths.some((prefix) => {
        const cleanPrefix = String(prefix).replace(/^\.\//, "").replace(/\/$/, "");
        return normalizedTarget === cleanPrefix ||
          normalizedTarget.startsWith(`${cleanPrefix}/`) ||
          cleanPrefix.startsWith(`${normalizedTarget}/`);
      });
    });
    if (!pathCovered) return { valid: false, reason: "DELEGATION_PATH_OUTSIDE_SCOPE" };
  }
  return { valid: true, receipt };
}

// Business purpose: extracts normalized project-relative file or directory paths targeted by an exploration tool call.
// Technical description: inspects tool-specific input properties (path, file_path, paths) and returns a deduplicated string array.
function extractTargetPaths(toolName, input = {}) {
  if (toolName === "read_file" || toolName === "git_blame" || toolName === "git_log" || toolName === "git_show") {
    const single = typeof input?.path === "string" && input.path.trim() ? [input.path.trim()] : [];
    const many = Array.isArray(input?.paths) ? input.paths.filter((p) => typeof p === "string" && p.trim()) : [];
    return [...single, ...many];
  }
  if (toolName === "Read") {
    return typeof input?.file_path === "string" && input.file_path.trim() ? [input.file_path.trim()] : [];
  }
  if (toolName === "search_tree") {
    return typeof input?.path === "string" && input.path.trim() && input.path.trim() !== "." ? [input.path.trim()] : [];
  }
  if (toolName === "search_text" || toolName === "git_status" || toolName === "git_diff") {
    return Array.isArray(input?.paths) ? input.paths.filter((p) => typeof p === "string" && p.trim()) : [];
  }
  return [];
}

// Business purpose: verifies that a previously recorded SHA-256 checksum still matches the current file content on disk.
// Technical description: resolves the project-relative path against project_root and compares the computed SHA-256 digest with expectedSha256.
function verifyDiskShaFresh(path, expectedSha256, context = {}) {
  if (!path || typeof expectedSha256 !== "string" || !expectedSha256.startsWith("sha256:")) return false;
  const root = context.project_root ?? context.evidence_scope?.projectRoot ?? null;
  if (!root || typeof root !== "string") return true;
  try {
    const fullPath = resolve(root, path);
    if (!existsSync(fullPath)) return false;
    const diskSha = `sha256:${createHash("sha256").update(readFileSync(fullPath)).digest("hex")}`;
    return diskSha === expectedSha256;
  } catch {
    return false;
  }
}

// Business purpose: checks whether a file already has fresh verified evidence in active_file_checksums or observed_files.
// Technical description: looks up the stored SHA-256 for the path, verifies disk freshness, and emits stale telemetry if the file changed.
function hasFreshActiveChecksum(path, context = {}) {
  if (!path || typeof path !== "string") return false;
  const normalized = path.replace(/^\.\//, "");
  const checksums = context.active_file_checksums;
  let storedSha = null;
  if (checksums && typeof checksums === "object") {
    const entry = checksums[normalized] ?? checksums.files?.[normalized];
    storedSha = typeof entry === "string" ? entry : entry?.sha256 ?? null;
  }
  if (!storedSha && Array.isArray(context.observed_files)) {
    const obs = context.observed_files.find((item) => item?.path === normalized);
    storedSha = obs?.sha256 ?? null;
  }
  if (!storedSha) return false;
  const fresh = verifyDiskShaFresh(normalized, storedSha, context);
  if (!fresh) {
    emitDelegatedDiscoveryTelemetry(context, "subagent.evidence_marked_stale", "stale", `Stored checksum for ${normalized} is stale on disk.`, {
      path: normalized,
      stored_sha256: storedSha
    });
  }
  return fresh;
}

// Business purpose: evaluates the 6 controlled exceptions that allow a parent agent to read without a new subagent delegation.
// Technical description: checks child read-only context, fallback_to_parent state, tool error reconciliation, mandatory rule files, owner-specified paths, and fresh active checksums.
function isControlledException(context = {}, toolName, targetPaths = []) {
  if (context.read_only_enforced === true && Number(context.subagent_depth ?? 0) >= 1) {
    return { allowed: true, exception: "child_subagent_read_only" };
  }
  if (
    context.subagent_fallback_to_parent?.fallback_to_parent === true &&
    typeof context.subagent_fallback_to_parent?.reason === "string" &&
    context.subagent_fallback_to_parent.reason.trim().length > 0
  ) {
    return { allowed: true, exception: "fallback_to_parent", reason: context.subagent_fallback_to_parent.reason };
  }
  if (context.handling_tool_error === true || context.reconciling_tool_result === true) {
    return { allowed: true, exception: "tool_error_or_result_reconciliation" };
  }
  if (targetPaths.length === 1) {
    const singlePath = targetPaths[0].replace(/^\.\//, "");
    if (MANDATORY_RULE_FILE_PATTERN.test(singlePath)) {
      return { allowed: true, exception: "mandatory_rule_file", path: singlePath };
    }
    const explicitOwnerPaths = [
      ...(Array.isArray(context.owner_explicit_paths) ? context.owner_explicit_paths : []),
      ...(Array.isArray(context.explicit_target_paths) ? context.explicit_target_paths : [])
    ].map((p) => String(p).replace(/^\.\//, ""));
    if (explicitOwnerPaths.includes(singlePath)) {
      return { allowed: true, exception: "owner_explicit_file", path: singlePath };
    }
    if (["read_file", "Read", "git_blame", "git_diff", "git_log", "git_show"].includes(toolName) && hasFreshActiveChecksum(singlePath, context)) {
      return { allowed: true, exception: "fresh_active_file_checksum", path: singlePath };
    }
  }
  if (targetPaths.length > 1 && ["git_diff", "git_status"].includes(toolName)) {
    if (targetPaths.every((p) => hasFreshActiveChecksum(p.replace(/^\.\//, ""), context))) {
      return { allowed: true, exception: "fresh_active_file_checksums" };
    }
  }
  return { allowed: false };
}

// Business purpose: constructs the canonical SUBAGENT_REQUIRED error when a parent attempts unapproved direct discovery.
// Technical description: creates a ConfigurationError with error_code, required_action, and allowed_tools properties matching the architecture contract.
function createSubagentRequiredError(toolName, reason = "SUBAGENT_REQUIRED") {
  const payload = {
    error_code: "SUBAGENT_REQUIRED",
    message: "Parent must delegate read-only discovery before using this exploration tool.",
    required_action: "delegate_subagent",
    allowed_tools: [...ALLOWED_SUBAGENT_EXPLORATION_TOOLS],
    blocked_tool: toolName,
    reason
  };
  return Object.assign(new ConfigurationError(payload.message, payload), {
    code: "SUBAGENT_REQUIRED",
    error_code: "SUBAGENT_REQUIRED",
    required_action: "delegate_subagent",
    allowed_tools: [...ALLOWED_SUBAGENT_EXPLORATION_TOOLS],
    details: payload
  });
}

// Business purpose: enforces delegated-first discovery before a parent agent executes broad or targeted exploration tools.
// Technical description: checks whether mandatory parent subagent discovery is enabled on context, evaluates controlled exceptions, validates delegation receipts, and throws SUBAGENT_REQUIRED on violation.
export function assertDelegatedDiscoveryRequired(context = {}, toolName, input = {}) {
  if (!context || typeof context !== "object") return { allowed: true };
  if (!DELEGATED_DISCOVERY_TOOLS.includes(toolName)) return { allowed: true };

  if (context.read_only_enforced === true && Number(context.subagent_depth ?? 0) >= 1) {
    return { allowed: true, mode: "subagent_child" };
  }

  const enforced = Boolean(
    context.mandatory_subagent_discovery === true ||
    context.enforce_delegated_discovery === true ||
    context.delegated_discovery_policy === "mandatory" ||
    context.delegated_discovery_policy?.enforced === true
  );
  if (!enforced) return { allowed: true, mode: "advisory" };

  const targetPaths = extractTargetPaths(toolName, input);
  const exception = isControlledException(context, toolName, targetPaths);
  if (exception.allowed) {
    if (exception.exception === "fallback_to_parent") {
      emitDelegatedDiscoveryTelemetry(context, "subagent.fallback_parent_discovery", "fallback_to_parent", `Parent using ${toolName} under fallback_to_parent exception.`, {
        tool: toolName,
        reason: exception.reason
      });
    }
    return exception;
  }

  const receipts = Array.isArray(context.delegation_receipts) ? context.delegation_receipts : [];
  let lastFailureReason = "NO_DELEGATION_RECEIPT";
  for (const receipt of receipts) {
    const validation = validateDelegationReceipt(receipt, context, targetPaths);
    if (validation.valid) {
      if (receipt.fallback_to_parent) {
        emitDelegatedDiscoveryTelemetry(context, "subagent.fallback_parent_discovery", "fallback_to_parent", `Parent using ${toolName} after recorded subagent fallback.`, {
          tool: toolName,
          delegation_id: receipt.delegation_id,
          reason: receipt.fallback_reason ?? "subagent_fallback"
        });
      }
      return { allowed: true, receipt: validation.receipt };
    }
    lastFailureReason = validation.reason;
    if (validation.reason === "DELEGATION_EXPIRED") {
      emitDelegatedDiscoveryTelemetry(context, "subagent.delegation_expired", "expired", `Delegation ${receipt?.delegation_id ?? "unknown"} expired before ${toolName}.`, {
        tool: toolName,
        delegation_id: receipt?.delegation_id ?? null
      });
    }
  }

  emitDelegatedDiscoveryTelemetry(context, "subagent.parent_discovery_rejected", "rejected", "Parent must delegate read-only discovery before using this exploration tool.", {
    error_code: "SUBAGENT_REQUIRED",
    tool: toolName,
    reason: lastFailureReason,
    target_paths: targetPaths,
    required_action: "delegate_subagent",
    allowed_tools: [...ALLOWED_SUBAGENT_EXPLORATION_TOOLS]
  });
  throw createSubagentRequiredError(toolName, lastFailureReason);
}
