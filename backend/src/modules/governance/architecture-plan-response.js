// Normalizes Architecture's discovery preamble while preserving plan evidence and approval boundaries.
import { decisionError } from "./architecture-owner-decisions.js";

// Moves discovery commentary below the single plan title without discarding evidence or accepting multiple plans.
export function parseArchitecturePlan(raw) {
  const text = String(raw ?? "").trim();
  const titles = [...text.matchAll(/^# Plan:[ \t]*\S.*$/gm)];
  if (titles.length !== 1) throw decisionError("ARCHITECTURE_PLAN_INVALID", "Architecture must return one Markdown plan with a # Plan: title.");
  const [title] = titles;
  const preamble = text.slice(0, title.index).trim();
  if (!preamble) return text;
  if (/^\s*(?:#{1,6}\s|`{3,}|~{3,})/m.test(preamble)) throw decisionError("ARCHITECTURE_PLAN_INVALID", "Architecture returned an ambiguous or wrapped Markdown plan; retry with one plain Markdown plan.");
  return `${title[0]}\n\n${preamble}\n\n${text.slice(title.index + title[0].length).trim()}`;
}
