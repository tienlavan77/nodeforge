// Summary: Classifies ticket complexity before dispatch so simple checklist
// tickets get small reasoning/exploration budgets instead of complex-task ones.

const PRESERVE_PATTERNS = [
  /preserve\s+(the\s+)?existing/i,
  /do\s+not\s+change[\s\S]{0,40}unless/i,
  /without\s+changing/i,
  /no\s+hard-coded/i
];

const OPEN_ENDED_PATTERNS = [
  /\b(design|decide|consider|explore|investigate|propose|refactor|improve|optimize)\b/i,
  /\b(migration|security|performance)\b/i
];

// "backend/scripts/x.mjs" style path prefixes must not count as backend scope —
// the pattern below excludes tokens immediately followed by a slash. A bare
// filename mention (validate-schemas.mjs) also only counts when it is the
// ticket's target, which the explicit-location credit already handles.
const BACKEND_SCOPE_PATTERNS = [
  /\b(api|backend|database|migration|endpoint|contract|worker|queue|supervisor)\b(?![\w]*\/)/i,
  /\b(schema)\s+(migration|change|update|design)\b/i
];

const EXPLICIT_LOCATION_PATTERNS = [
  /\bin\s+the\s+["']?[\w\s-]+["']?\s+(column|component|panel|page|screen|modal|heading|button)\b/i,
  /\b[\w-]+\.(tsx?|jsx?|css|scss)\b/
];

export const COMPLEXITY_CONFIG = Object.freeze({
  simple: Object.freeze({ effort: "low", discovery_budget: 4, max_turns: 15, thinking: { type: "enabled", budgetTokens: 2048 } }),
  moderate: Object.freeze({ effort: "medium", discovery_budget: 8, max_turns: 25, thinking: { type: "enabled", budgetTokens: 4096 } }),
  complex: Object.freeze({ effort: "high", discovery_budget: 12, max_turns: 40, thinking: { type: "adaptive" } })
});

export function classifyTicketComplexity(ticket) {
  const text = ticketText(ticket);
  const criteria = (ticket?.acceptance_criteria ?? []).filter((item) => typeof item === "string");
  const reasoning = [];
  let score = 0;

  if (criteria.length > 5) { score += 1; reasoning.push(`${criteria.length} acceptance criteria (>5) → +1`); }
  if (PRESERVE_PATTERNS.some((pattern) => pattern.test(text))) { score -= 1; reasoning.push('preserve-scope constraint → -1 (closed checklist)'); }
  if (BACKEND_SCOPE_PATTERNS.some((pattern) => pattern.test(text))) { score += 2; reasoning.push('backend scope → +2'); }
  if (OPEN_ENDED_PATTERNS.some((pattern) => pattern.test(text))) { score += 3; reasoning.push('open-ended language → +3'); }
  if (EXPLICIT_LOCATION_PATTERNS.some((pattern) => pattern.test(text))) { score -= 2; reasoning.push('explicit component/file location → -2 (no broad search needed)'); }
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 25) { score += 1; reasoning.push(`ticket text very short (${words} words) → +1 (thin context)`); }

  const level = score <= 0 ? "simple" : score <= 3 ? "moderate" : "complex";
  reasoning.push(`total score ${score} → "${level}"`);
  return { level, ...COMPLEXITY_CONFIG[level], reasoning };
}

function ticketText(ticket) {
  return [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])]
    .filter((value) => typeof value === "string")
    .join("\n");
}
