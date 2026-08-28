/**
 * Formats a structured ticket for chat without mutating or dispatching it.
 * Plain prose is returned unchanged.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatTicketResponse(value) {
  const json = toStructuredJson(value);

  if (json === undefined) {
    return typeof value === 'string' ? value : String(value ?? '');
  }

  return `\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;
}

function toStructuredJson(value) {
  if (value !== null && typeof value === 'object') {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    // Scalar JSON strings/numbers are normal chat content, not ticket payloads.
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    // Invalid JSON must remain prose so the original message is not lost.
    return undefined;
  }
}

export default formatTicketResponse;
