// Records owner policy choices in Architecture Markdown so Sprint Leader consumes decisions instead of asking again.
import { ConfigurationError } from "../../shared/errors.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MARKER = /```nodeforge-owner-decisions\s*\n([\s\S]*?)\n```/g;

// Rejects malformed clarification data before it can become an owner decision.
export function validateArchitectureQuestions(questions) {
  if (!Array.isArray(questions) || questions.length > 20) throw decisionError("ARCHITECTURE_QUESTIONS_INVALID", "Architecture must return at most 20 structured owner questions.");
  const ids = new Set();
  for (const question of questions) {
    if (!question || !ID.test(question.id ?? "") || ids.has(question.id) || typeof question.title !== "string" || !question.title.trim() || typeof question.reason !== "string" || !question.reason.trim() || !Array.isArray(question.options) || question.options.length < 2 || question.options.length > 10
      || question.options.some((option) => !option || !ID.test(option.id ?? "") || typeof option.label !== "string" || !option.label.trim() || typeof option.description !== "string" || !option.description.trim())
      || new Set(question.options.map((option) => option.id)).size !== question.options.length || question.recommended_option_id != null && !question.options.some((option) => option.id === question.recommended_option_id)) throw decisionError("ARCHITECTURE_QUESTIONS_INVALID", "Questions need unique IDs, concrete alternatives, rationale and valid recommendations.");
    ids.add(question.id);
  }
  return structuredClone(questions);
}

// Resolves only explicit supported owner choices, never the agent's recommendation.
export function architectureSelections(questions, selections = {}, { complete = true } = {}) {
  if (!selections || typeof selections !== "object" || Array.isArray(selections) || Object.keys(selections).some((id) => !questions.some((question) => question.id === id))) throw decisionError("ARCHITECTURE_SELECTION_INVALID", "Choices must belong to this clarification request.");
  return Object.fromEntries(questions.flatMap((question) => {
    if (!Object.hasOwn(selections, question.id)) {
      if (complete) throw decisionError("ARCHITECTURE_SELECTION_REQUIRED", `Choose an option for ${question.title}.`);
      return [];
    }
    if (!question.options.some((option) => option.id === selections[question.id])) throw decisionError("ARCHITECTURE_SELECTION_INVALID", "Unsupported owner option.");
    return [[question.id, selections[question.id]]];
  }));
}

// Writes Node's authenticated decisions into the exact plan bytes that the owner will review.
export function appendArchitectureDecisions(markdown, session) {
  const decisions = session.questions.map((question) => {
    const option = question.options.find((entry) => entry.id === session.selections[question.id]);
    return { id: question.id, title: question.title, reason: question.reason, option_id: option.id, label: option.label, description: option.description, owner_note: session.notes?.[question.id] ?? "" };
  });
  const record = { schema_version: 1, session_id: session.session_id, source_path: session.source_path, source_sha256: session.source_sha256, owner_id: session.owner_id ?? null, confirmed_at: session.confirmed_at ?? null, decisions };
  const prose = decisions.length ? decisions.map((entry) => `- **${entry.title}: ${entry.label}** — ${entry.description}${entry.owner_note ? `\n  Owner note: ${entry.owner_note}` : ""}`).join("\n") : "No additional owner policy decisions were required.";
  return `${markdown.replace(MARKER, "").trim()}\n\n## 8. Owner decisions\n\n${prose}\n\n\`\`\`nodeforge-owner-decisions\n${JSON.stringify(record)}\n\`\`\`\n`;
}

// Reads authenticated choices from an intact approved Architecture artifact at Sprint handoff.
export function readArchitectureDecisions(markdown) {
  const matches = [...String(markdown).matchAll(MARKER)];
  if (!matches.length) return null;
  if (matches.length !== 1) throw decisionError("ARCHITECTURE_DECISIONS_INVALID", "Plan has conflicting owner decision records.");
  let record;
  try { record = JSON.parse(matches[0][1]); } catch (error) { throw decisionError("ARCHITECTURE_DECISIONS_INVALID", `Invalid owner decision record: ${error.name}.`); }
  if (!record || record.schema_version !== 1 || !ID.test(record.session_id ?? "") || typeof record.source_path !== "string" || !record.source_path || !/^[a-f0-9]{64}$/.test(record.source_sha256 ?? "") || !Array.isArray(record.decisions) || record.decisions.length && (!record.owner_id || !record.confirmed_at)
    || record.decisions.some((entry) => !entry || !ID.test(entry.id ?? "") || !ID.test(entry.option_id ?? "") || [entry.title, entry.reason, entry.label, entry.description].some((value) => typeof value !== "string" || !value.trim())) || new Set(record.decisions.map((entry) => entry.id)).size !== record.decisions.length) throw decisionError("ARCHITECTURE_DECISIONS_INVALID", "Plan decisions lack their owner, policy or source identity.");
  return record;
}

// Provides actionable planning errors without granting execution or approval authority.
export function decisionError(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }
