// Runtime instance helpers keep child execution identifiers safe and isolated across provider gateways.

// Business purpose: validates opaque subagent identifiers before they become runtime keys or filesystem segments.
// Technical description: accepts only bounded alphanumeric, underscore, and hyphen identifiers and rejects traversal.
export function safeSubagentId(value, provider = "SDK") {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    const error = new Error(`${provider} subagent_id is invalid.`);
    error.code = "SUBAGENT_ID_INVALID";
    throw error;
  }
  return value;
}

// Business purpose: accepts project-scoped conversation IDs without weakening short-lived subagent ID validation.
// Technical description: permits bounded path-safe opaque identifiers long enough for generated plan and handoff conversation names.
export function safeConversationId(value, provider = "SDK") {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/.test(value)) {
    const error = new Error(`${provider} conversation_id is invalid.`);
    error.code = "CONVERSATION_ID_INVALID";
    throw error;
  }
  return value;
}
