// Business purpose: recognizes natural language chat directives and slash shortcuts (/se, /am, /coder, /directive) and provides the unified send_execution_directive Forge tool so the Project Owner, Architecture Manager, or Sprint Leader can steer or pause running AM, SE, or Coder executions without manual ID lookups.
// Technical description: parses non-fenced, non-quoted, non-interrogative lines for directive intent, infers target_role (am, se, coder) and directive kind (implementation_guidance, focus_constraint, pause_after_turn), and executes send_execution_directive against createTicketDirectiveInbox with automatic active handoff/ticket resolution.
import { ConfigurationError } from "../../shared/errors.js";
import { ALLOWED_DIRECTIVE_KINDS, ALLOWED_TARGET_ROLES, normalizeTargetRole } from "../supervisor/ticket/ticket-directive-inbox.js";

const FENCE_RE = /^[ \t]*(```|~~~)/;

const SLASH_DIRECTIVE_RE = /^\/(?<cmd>se|am|coder|directive)(?:\s+(?<explicit_role>se|am|coder)\b\s*[:,-]?)?\s+(?<body>.+)$/i;

const NATURAL_PAUSE_PATTERNS = [
  /^(?:please\s+)?(?:tạm\s+dừng|dừng)\s+(?<role>se|am|coder|system\s+engineer|architecture\s+manager)(?:\s+đang\s+chạy)?(?:\s+sau\s+(?:bước|lượt|turn|vòng)\s+này)?(?:\s*[:,-]\s*(?<note>.+))?[.!]?$/i,
  /^(?:please\s+)?pause\s+(?<role>se|am|coder|system\s+engineer|architecture\s+manager)(?:\s+after\s+(?:this\s+)?(?:turn|step|round))?(?:\s*[:,-]\s*(?<note>.+))?[.!]?$/i
];

const NATURAL_DIRECTIVE_PATTERNS = [
  /^(?:please\s+)?(?:nhắn|báo|dặn|nhắc|gửi\s+(?:chỉ\s+thị|yêu\s+cầu(?:\s+thêm|\s+bổ\s+sung)?|tin\s+nhắn)|bổ\s+sung(?:\s+yêu\s+cầu)?)\s+(?:cho\s+)?(?<role>se|am|coder|system\s+engineer|architecture\s+manager)(?:\s+đang\s+chạy)?(?:\s+(?:trong|ở)\s+(?<target_id>(?:HANDOFF|TICKET)-[A-Za-z0-9._:-]+))?\s*[:,-]\s*(?<body>.+)$/i,
  /^(?:please\s+)?(?<role>se|am|coder)\s+ơi\s*[,:-]?\s*(?<body>.+)$/i,
  /^(?:please\s+)?(?:tell|message|instruct|direct|send\s+(?:a\s+)?directive\s+to)\s+(?<role>se|am|coder|system\s+engineer|architecture\s+manager)(?:\s+on\s+(?<target_id>(?:HANDOFF|TICKET)-[A-Za-z0-9._:-]+))?\s*[:,-]\s*(?<body>.+)$/i
];

// Business purpose: infers the canonical directive kind from natural language instruction text when the caller does not specify an explicit kind.
// Technical description: checks for pause keywords first, then focus/scope constraint keywords, and defaults to implementation_guidance.
export function inferDirectiveKind(text, explicitKind = null) {
  if (typeof explicitKind === "string" && ALLOWED_DIRECTIVE_KINDS.has(explicitKind.trim())) {
    return explicitKind.trim();
  }
  const value = String(text ?? "").trim();
  if (/^(?:(?:please|hãy|nhớ)\s+)?(?:tạm\s+dừng|dừng\s+lại|tạm\s+ngưng|pause\b)(?:\s+sau\s+(?:bước|lượt|turn|vòng)\s+này|\s+after\s+(?:this\s+)?(?:turn|step|round))?[.!]?$/i.test(value)) {
    return "pause_after_turn";
  }
  if (/(?:\bchỉ\s+sửa\b|\bưu\s+tiên\s+sửa\b|\bgiữ\s+nguyên\b|\bkhông\s+sửa\b|\bđừng\s+sửa\b|\bonly\s+(?:edit|modify|touch)\b|\bdo\s+not\s+(?:edit|modify|touch)\b|\bkeep\s+.*\b(?:unchanged|intact)\b)/i.test(value)) {
    return "focus_constraint";
  }
  return "implementation_guidance";
}

// Business purpose: parses a chat message to detect whether the Project Owner is issuing a slash shortcut or natural language execution directive to AM, SE, or Coder.
// Technical description: scans non-fenced, non-quoted, non-interrogative lines and returns { target_role, target_id, kind, instruction, supersede_pending, trigger_type } or null.
export function parseConversationDirectiveTrigger(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let fenced = false;
  for (const rawLine of lines) {
    if (FENCE_RE.test(rawLine)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = rawLine.trim();
    if (!line || line.endsWith("?") || line.endsWith("？") || line.startsWith(">")) continue;

    const slash = SLASH_DIRECTIVE_RE.exec(line);
    if (slash) {
      const cmd = slash.groups.cmd.toLowerCase();
      const explicitRole = normalizeTargetRole(slash.groups.explicit_role);
      const targetRole = cmd === "directive" ? (explicitRole ?? "coder") : normalizeTargetRole(cmd);
      const rawBody = slash.groups.body.trim();
      const idMatch = /^(?<id>(?:HANDOFF|TICKET)-[A-Za-z0-9._:-]+)\s*[:,-]?\s+(?<rest>.+)$/i.exec(rawBody);
      const targetId = idMatch ? idMatch.groups.id : null;
      const instruction = (idMatch ? idMatch.groups.rest : rawBody).trim();
      if (!instruction) return null;
      const kind = inferDirectiveKind(instruction);
      return {
        line,
        trigger_type: "slash_command",
        command: `/${cmd}`,
        target_role: targetRole,
        target_id: targetId,
        kind,
        instruction,
        supersede_pending: false
      };
    }

    for (const pattern of NATURAL_PAUSE_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        const targetRole = normalizeTargetRole(match.groups?.role);
        if (!targetRole) continue;
        const note = match.groups?.note?.trim();
        return {
          line,
          trigger_type: "natural_language",
          command: "/directive",
          target_role: targetRole,
          target_id: null,
          kind: "pause_after_turn",
          instruction: note || `Pause ${targetRole.toUpperCase()} execution safely at the next turn boundary.`,
          supersede_pending: false
        };
      }
    }

    for (const pattern of NATURAL_DIRECTIVE_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        const targetRole = normalizeTargetRole(match.groups?.role);
        const instruction = match.groups?.body?.trim() ?? "";
        if (!targetRole || !instruction) continue;
        return {
          line,
          trigger_type: "natural_language",
          command: "/directive",
          target_role: targetRole,
          target_id: match.groups?.target_id?.trim() ?? null,
          kind: inferDirectiveKind(instruction),
          instruction,
          supersede_pending: false
        };
      }
    }
  }
  return null;
}

// Business purpose: checks whether a chat message contains a standalone execution directive trigger.
// Technical description: returns the matched line from parseConversationDirectiveTrigger or null.
export function detectConversationDirectiveTrigger(text) {
  return parseConversationDirectiveTrigger(text)?.line ?? null;
}

export const sendExecutionDirectiveDefinition = Object.freeze({
  name: "send_execution_directive",
  description: "Dispatch a mid-flight execution directive (implementation guidance, focus constraint, or safe turn-boundary pause) to an active System Engineer (se), Architecture Manager (am), or Coder (coder) handoff or ticket.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["instruction"],
    properties: {
      target_role: {
        type: "string",
        enum: ["se", "am", "coder"],
        description: "Target execution role (se, am, or coder). Optional when target_id or active session context resolves it."
      },
      target_id: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Optional HANDOFF-... or TICKET-... identifier. Automatically resolved from active project handoffs/tickets when omitted."
      },
      kind: {
        type: "string",
        enum: ["implementation_guidance", "focus_constraint", "pause_after_turn"],
        description: "Directive classification (defaults to implementation_guidance or inferred from instruction)."
      },
      instruction: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description: "Natural language directive instruction for the target agent."
      },
      supersede_pending: {
        type: "boolean",
        description: "When true, marks earlier pending directives of the same kind and role as superseded."
      }
    }
  }
});

// Business purpose: creates the executable Forge tool handler for send_execution_directive backed by the project's TicketDirectiveInbox.
// Technical description: resolves target_id and target_role automatically when omitted, validates sender identity from tool context, and enqueues the directive atomically.
export function createSendExecutionDirectiveTool({ directiveInbox, conversationId = null } = {}) {
  if (!directiveInbox?.enqueue || !directiveInbox?.resolveActiveTarget) {
    throw new ConfigurationError("send_execution_directive requires a configured directiveInbox.");
  }
  return Object.freeze({
    name: "send_execution_directive",
    definition: sendExecutionDirectiveDefinition,
    async execute(input = {}, context = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw Object.assign(new ConfigurationError("send_execution_directive input must be an object."), { code: "INPUT_INVALID" });
      }
      const allowedKeys = new Set(["target_role", "target_id", "kind", "instruction", "supersede_pending"]);
      for (const key of Object.keys(input)) {
        if (!allowedKeys.has(key)) {
          throw Object.assign(new ConfigurationError(`Unsupported send_execution_directive field: ${key}`), { code: "INPUT_INVALID" });
        }
      }
      const normalizedRole = normalizeTargetRole(input.target_role);
      if (input.target_role !== undefined && (!normalizedRole || !ALLOWED_TARGET_ROLES.has(normalizedRole))) {
        throw Object.assign(new ConfigurationError(`Invalid target_role '${input.target_role}'. Expected se, am, or coder.`), { code: "DIRECTIVE_TARGET_ROLE_INVALID" });
      }
      const resolved = await directiveInbox.resolveActiveTarget({
        targetId: input.target_id ?? null,
        targetRole: normalizedRole,
        conversationId: context?.conversation_id ?? context?.evidence_scope?.conversationId ?? conversationId ?? null
      });
      const kind = inferDirectiveKind(input.instruction, input.kind);
      const senderRole = context?.agent_identity?.role ?? "project_owner";
      const senderId = context?.agent_identity?.agent_id ?? senderRole;
      const created = await directiveInbox.enqueue({
        taskId: resolved.target_id,
        targetRole: resolved.target_role,
        sender: { id: senderId, role: senderRole },
        kind,
        instruction: input.instruction,
        supersedePending: input.supersede_pending === true
      });
      return {
        status: "enqueued",
        directive_id: created.directive_id,
        target_id: created.task_id,
        handoff_id: created.handoff_id,
        target_role: created.target_role,
        kind: created.kind,
        instruction: created.instruction,
        supersede_pending: input.supersede_pending === true
      };
    }
  });
}
