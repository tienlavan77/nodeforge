// Preserves actionable validation feedback and bounded rejected responses for automatic SL/AM correction.
import { createHash } from "node:crypto";

// Identifies the exact failed response field without granting permission to change approved authority.
export function blockerValidationError(path, reason, message, { expected, received, retryable = true } = {}) {
  return Object.assign(new Error(message), { code: "BLOCKER_DISPOSITION_INVALID", retryable_disposition: retryable,
    validation_errors: [{ path, reason, message, ...(expected === undefined ? {} : { expected }),
      ...(received === undefined ? {} : { received }) }] });
}

// Bounds provider evidence while retaining a checksum when a response exceeds the durable audit budget.
export function blockerResponseEvidence(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "null";
  const bytes = Buffer.from(text);
  return { text: bytes.subarray(0, 48_000).toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex"),
    truncated: bytes.length > 48_000 };
}
