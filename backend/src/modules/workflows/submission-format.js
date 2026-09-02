import { ConfigurationError } from "../../shared/errors.js";

/** Canonical submission representations accepted by the Node-Agent protocol. */
export const SUBMISSION_FORMATS = Object.freeze(["full_content", "unified_diff", "apply_patch", "structured_patch", "per_file"]);

const ALIASES = Object.freeze({
  full: "full_content",
  full_content: "full_content",
  unified_diff: "unified_diff",
  patch: "apply_patch",
  apply_patch: "apply_patch",
  structured_patch: "structured_patch",
  per_file: "per_file"
});

/** Normalize a requested representation and fail before a provider call. */
export function resolveSubmissionFormat(value = "full_content") {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  const format = ALIASES[normalized];
  if (!format) {
    const error = new ConfigurationError(`Unsupported submission format: ${String(value)}.`);
    error.code = "SUBMISSION_FORMAT_UNSUPPORTED";
    throw error;
  }
  return format;
}

export function requestedSubmissionFormat(source = {}) {
  return resolveSubmissionFormat(
    source.submissionFormat
      ?? source.submission_format
      ?? source.expected_submission?.representation
      ?? source.expected_output?.representation
      ?? "full_content"
  );
}
