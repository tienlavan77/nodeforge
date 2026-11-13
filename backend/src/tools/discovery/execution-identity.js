// Business purpose: gives every discovery tool one execution identity so source evidence cannot cross execution, task, conversation, or delegation boundaries.
// Technical description: normalizes snake_case and camelCase context fields into a frozen, provider-neutral identity used for receipt and read-deduplication keys.

// Business purpose: resolves the authoritative execution context used to isolate source receipts and reads.
// Technical description: accepts the supported serialized field spellings in deterministic precedence order and preserves the distinct conversation and delegation dimensions.
export function normalizeExecutionIdentity(context = {}) {
  const executionId = context.execution_id ?? context.executionId ?? context.task_id ?? context.taskId ?? "";
  return Object.freeze({
    execution_id: executionId,
    conversation_id: context.conversation_id ?? context.conversationId ?? context.task_id ?? context.taskId ?? "",
    delegation_id: context.delegation_id ?? context.delegationId ?? executionId
  });
}

// Business purpose: produces the stable namespace used by source receipts and deduplicated reads.
// Technical description: serializes normalized execution identity fields without allowing caller key spelling to create aliases.
export function executionIdentityKey(context = {}) {
  const identity = normalizeExecutionIdentity(context);
  return [identity.execution_id, identity.conversation_id, identity.delegation_id].join("\u001f");
}
