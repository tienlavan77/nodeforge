// Preserves Architecture Manager planning discussions across SDK session rollovers.
// The durable memory retains attributed conversation evidence instead of treating file receipts
// or assistant proposals as owner decisions. Bounds are explicit so context remains predictable.
const MAX_CHARS = 64000;
const MAX_ENTRIES = 160;

/**
 * Merges previously retained planning discussion with newly available conversation turns.
 * Exact repeated transport history is deduplicated; owner wording is retained intact whenever
 * it fits the budget. Older assistant proposals are evicted before owner requirements, and
 * every omission is recorded so the next agent cannot assume its memory is complete.
 */
export function buildArchitectureConversationMemory(previous, history = []) {
  const entries = [];
  let truncated = previous?.truncated === true;
  for (const turn of [...(previous?.entries ?? []), ...(Array.isArray(history) ? history : [])]) {
    if (!["User", "Assistant"].includes(turn?.role) || typeof turn.text !== "string" || !turn.text.trim()) continue;
    if (turn.text.startsWith("Architecture clarification discovery") || turn.text.startsWith("Architecture plan generation") || turn.text.startsWith("Architecture plan update")) continue;
    const key = JSON.stringify([turn.role, turn.text]);
    const repeated = entries.findIndex((entry) => JSON.stringify([entry.role, entry.text]) === key);
    if (repeated >= 0) entries.splice(repeated, 1);
    const text = turn.text.length > MAX_CHARS / 2 ? turn.text.slice(0, MAX_CHARS / 4) + "\n[Middle omitted]\n" + turn.text.slice(-MAX_CHARS / 4) : turn.text;
    if (text !== turn.text) truncated = true;
    entries.push({ role: turn.role, text });
  }
  let chars = entries.reduce((sum, turn) => sum + turn.text.length, 0);
  while (entries.length > MAX_ENTRIES || chars > MAX_CHARS) {
    const assistant = entries.findIndex((turn, index) => turn.role === "Assistant" && index < entries.length - 4);
    const index = assistant >= 0 ? assistant : entries.length > 2 ? 1 : 0;
    chars -= entries[index].text.length;
    entries.splice(index, 1);
    truncated = true;
  }
  return { schema_version: 1, entries, truncated };
}

/**
 * Restores planning conversation evidence into a fresh AM session without authorizing work.
 * Explicit attribution prevents an assistant suggestion from becoming an approved decision;
 * the latest owner message remains authoritative over older retained requirements.
 */
export function formatArchitectureConversationMemory(memory) {
  if (!memory?.entries?.length) return "";
  return "\nArchitecture planning conversation memory:\n"
    + "Use this discussion to retain the owner's goals, constraints, rejected alternatives, open questions and plan/revision references. "
    + "User entries are owner statements; Assistant entries are proposals or reports, never approval by themselves. "
    + "Resolve changes using the latest explicit owner instruction. Do not infer approval, implementation completion or handoff from a proposal. "
    + "Stay in the AM discussion/planning role; do not restart completed discussions or ask again about explicit retained decisions. "
    + (memory.truncated ? "Some older discussion was omitted. State uncertainty and retrieve the relevant conversation/plan evidence before relying on a missing decision. " : "")
    + JSON.stringify(memory) + "\n";
}
