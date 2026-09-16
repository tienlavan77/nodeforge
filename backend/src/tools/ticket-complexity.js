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

// Multi-area tickets name distinct functional surfaces (e.g. a UI layout AND a
// database/API change AND responsive behavior). Each area needs its own
// discovery round, so a ticket touching several areas cannot finish inside a
// single-area budget. Counting distinct areas (not raw word count) is what
// promotes these out of "simple", which previously capped a 4-criteria
// full-stack ticket at 15 turns and failed it mid-work.
const FUNCTIONAL_AREAS = [
  { name: "ui-layout", pattern: /\b(ui|layout|responsive|screen|modal|component|column|panel|heading|button|front-?end|react|next(?:\.js)?)\b/i },
  { name: "data-api", pattern: /\b(database|db|sqlite|api|endpoint|contract|schema|migration|request|response|persist|store|fetch|payload)\b/i }
];
const MIN_AREAS_FOR_BUMP = 2;

export const COMPLEXITY_CONFIG = Object.freeze({
  simple: Object.freeze({ effort: "low", discovery_budget: 6, candidate_calls: 1, search_calls: 2, read_calls: 2, edit_must_start_by: 5, allow_escalation: false, max_turns: 15, thinking: { type: "enabled", budgetTokens: 2048 } }),
  moderate: Object.freeze({ effort: "medium", discovery_budget: 12, candidate_calls: 2, search_calls: 4, read_calls: 4, edit_must_start_by: 8, allow_escalation: true, max_turns: 25, thinking: { type: "enabled", budgetTokens: 4096 } }),
  complex: Object.freeze({ effort: "high", discovery_budget: 18, candidate_calls: 4, search_calls: 6, read_calls: 6, edit_must_start_by: 12, allow_escalation: true, max_turns: 40, thinking: { type: "adaptive" } })
});

// The simple tier's 15-turn cap is sized for a single-area edit (change one
// column, add one label). A ticket that spans several functional areas needs
// at least one discovery round + edits per area, so 15 turns is not enough.
// When multi-area detection fires we floor the ticket to the moderate budget
// (>= 1 discovery round per area) so the run cannot be cut off mid-work.
export const MULTI_AREA_MIN_TURNS = COMPLEXITY_CONFIG.moderate.max_turns;
export const MULTI_AREA_MIN_DISCOVERY = COMPLEXITY_CONFIG.moderate.discovery_budget;

export function classifyTicketComplexity(ticket) {
  const text = ticketText(ticket);
  const criteria = (ticket?.acceptance_criteria ?? []).filter((item) => typeof item === "string");
  const reasoning = [];
  let score = 0;

  const hasBackend = BACKEND_SCOPE_PATTERNS.some((pattern) => pattern.test(text));
  const hasOpenEnded = OPEN_ENDED_PATTERNS.some((pattern) => pattern.test(text));
  const areas = detectFunctionalAreas(criteria, text);
  const multiArea = areas.length >= MIN_AREAS_FOR_BUMP;
  const broadScope = hasBackend || hasOpenEnded || multiArea;

  if (criteria.length > 5) {
    const weight = broadScope ? 4 : 2;
    score += weight;
    reasoning.push(`${criteria.length} acceptance criteria (>5, ${broadScope ? "broad" : "focused single-area"} scope) → +${weight}`);
  }
  if (PRESERVE_PATTERNS.some((pattern) => pattern.test(text))) { score -= 1; reasoning.push('preserve-scope constraint → -1 (closed checklist)'); }
  if (hasBackend) { score += 2; reasoning.push('backend scope → +2'); }
  if (hasOpenEnded) { score += 3; reasoning.push('open-ended language → +3'); }
  if (EXPLICIT_LOCATION_PATTERNS.some((pattern) => pattern.test(text))) { score -= 2; reasoning.push('explicit component/file location → -2 (no broad search needed)'); }
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 25) { score += 1; reasoning.push(`ticket text very short (${words} words) → +1 (thin context)`); }

  if (multiArea) {
    score = Math.max(score, 1);
    reasoning.push(`multi-area ticket (criteria touch ${areas.join(" + ")}) → floor to ≥ ${MULTI_AREA_MIN_TURNS} turns`);
  }

  const level = score <= 0 ? "simple" : score <= 3 ? "moderate" : "complex";
  reasoning.push(`total score ${score} → "${level}"`);

  if (!multiArea) return { level, ...COMPLEXITY_CONFIG[level], reasoning };

  return {
    level: level === "simple" ? "moderate" : level,
    effort: level === "simple" ? COMPLEXITY_CONFIG.moderate.effort : COMPLEXITY_CONFIG[level].effort,
    discovery_budget: Math.max(COMPLEXITY_CONFIG[level].discovery_budget, MULTI_AREA_MIN_DISCOVERY),
    max_turns: Math.max(COMPLEXITY_CONFIG[level].max_turns, MULTI_AREA_MIN_TURNS),
    thinking: level === "simple" ? COMPLEXITY_CONFIG.moderate.thinking : COMPLEXITY_CONFIG[level].thinking,
    reasoning
  };
}

function detectFunctionalAreas(criteria, fallbackText) {
  const areas = new Set();
  const probes = criteria.length ? criteria : [fallbackText];
  for (const area of FUNCTIONAL_AREAS) {
    if (probes.some((text) => area.pattern.test(text))) areas.add(area.name);
  }
  return [...areas];
}

function ticketText(ticket) {
  return [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])]
    .filter((value) => typeof value === "string")
    .join("\n");
}
