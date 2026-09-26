// Interprets chat input and validates structured ticket requests.
export const MESSAGE_INTENTS = Object.freeze({ normalChat: "normal_chat", ticketCreate: "ticket_create" });

// Detects whether a message is chat or ticket related.
export function detectMessageIntent(input) {
  const text = String(input ?? "").trim();
  const normalized = normalizeTicketInput(text);
  if (normalized.recognized) return MESSAGE_INTENTS.ticketCreate;
  return MESSAGE_INTENTS.normalChat;
}

// Normalizes and validates ticket input text.
export function normalizeTicketInput(input) {
  const text = String(input ?? "");
  if (!text.trim()) return { text, normalized_text: "", recognized: false };
  const normalizedText = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const json = extractStructuredJson(normalizedText);
  if (json) {
    const recognized = ["id", "title", "objective", "acceptance_criteria"].some((field) => Object.prototype.hasOwnProperty.call(json, field));
    return { text, normalized_text: normalizedText, recognized, ticket: recognized ? json : undefined, missing: recognized ? requiredTicketFields(json) : [] };
  }
  const hasTicketLabel = /^\s*(?:[-*+]\s+)?(?:\*\*)?\s*(?:title|objective|acceptance[_ ]criteria|criteria|tiêu đề|mục tiêu|tiêu chí)\s*(?:\*\*)?\s*:/im.test(text);
  if (!hasTicketLabel && !/\b(create|tạo|thêm|implement|yêu cầu)\b[\s\S]*\b(ticket|task|công việc)\b/i.test(text)) return { text, normalized_text: normalizedText, recognized: false };
  const normalized = text.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*+]\s+)?(?:\*\*)?\s*(title|objective|acceptance[_ ]criteria|criteria|tiêu đề|mục tiêu|tiêu chí)\s*:\s*(?:\*\*)?/i, (_, label) => `${canonicalLabel(label)}:`)).join("\n");
  const fields = new Set([...normalized.matchAll(/^\s*(title|objective|acceptance_criteria)\s*:/gim)].map((match) => match[1].toLowerCase()));
  const missing = ["title", "objective", "acceptance_criteria"].filter((field) => !fields.has(field));
  const ticket = parseLabeledTicket(normalized);
  return { text: normalized, normalized_text: normalizedText, recognized: true, ticket: ticket ?? undefined, missing };
}

// Parses labeled ticket fields from text.
function parseLabeledTicket(text) {
  const fields = {};
  for (const match of String(text).matchAll(/^\s*(title|objective|acceptance_criteria)\s*:\s*([\s\S]*?)(?=^\s*(?:title|objective|acceptance_criteria)\s*:|$)/gim)) fields[match[1].toLowerCase()] = match[2].trim();
  if (!fields.title || !fields.objective || !fields.acceptance_criteria) return null;
  return { ...fields, acceptance_criteria: fields.acceptance_criteria.split(/\n|\s*[;|]\s*/).map((item) => item.replace(/^[-*]\s*/, "").trim()).filter(Boolean) };
}

// Maps localized labels to canonical ticket field names.
function canonicalLabel(label) {
  const key = label.toLowerCase().replace(/\s+/g, "_");
  return { "tiêu_đề": "title", "mục_tiêu": "objective", "tiêu_chí": "acceptance_criteria", criteria: "acceptance_criteria" }[key] ?? key;
}

// Extracts a JSON object embedded in text.
function extractStructuredJson(text) {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  let depth = 0; let quoted = false; let escaped = false;
  const opening = text[start]; const closing = opening === "{" ? "}" : "]";
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') quoted = false; continue; }
    if (character === '"') quoted = true;
    else if (character === opening) depth += 1;
    else if (character === closing && --depth === 0) { try { const value = JSON.parse(text.slice(start, index + 1)); return value && !Array.isArray(value) ? value : null; } catch { return null; } }
  }
  return null;
}

// Lists missing required ticket fields.
function requiredTicketFields(value) {
  return ["title", "objective", "acceptance_criteria"].filter((field) => {
    const item = value[field]; return field === "acceptance_criteria" ? !Array.isArray(item) || item.length === 0 : typeof item !== "string" || !item.trim();
  });
}
