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
