// Summary: Loads repository naming conventions and ticket-relevant vocabulary for tool-constrained agents.
import { readFile } from "node:fs/promises";

const SECTION_NAMES = ["Code summary comments", "Vocabulary glossary"];

// Builds the convention context that Node injects into a tool-constrained ticket prompt.
export async function loadAgentContextConventions({ projectRoot = process.cwd(), ticket } = {}) {
  const agentsText = await readOptional(`${projectRoot}/AGENTS.md`);
  const glossaryText = await readOptional(`${projectRoot}/vocabulary/glossary.md`);
  const sections = SECTION_NAMES.map((name) => extractSection(agentsText, name)).filter(Boolean);
  const mappings = selectGlossaryMappings(glossaryText, ticket);
  return Object.freeze({
    sections: Object.freeze(sections),
    mappings: Object.freeze(mappings),
    text: formatConventionContext(sections, mappings)
  });
}

// Reads an optional repository guidance file without blocking ticket dispatch.
async function readOptional(path) {
  // eslint-disable-next-line no-silent-catch -- Optional guidance file: absent file means empty section.
  try { return await readFile(path, "utf8"); } catch { return ""; }
}

// Extracts one named level-two Markdown section from repository instructions.
function extractSection(markdown, heading) {
  const match = String(markdown ?? "").match(new RegExp(`^## ${escapeRegExp(heading)}\\s*$([\\s\\S]*?)(?=^## |\\s*$)`, "mi"));
  return match ? `## ${heading}\n${match[1].trim()}` : "";
}

// Selects only glossary rows relevant to the ticket or its explicit hints.
function selectGlossaryMappings(markdown, ticket = {}) {
  const hints = normalizeHints(ticket.vocabulary_hints);
  const text = [ticket.title, ticket.objective, ...(ticket.acceptance_criteria ?? [])].filter((value) => typeof value === "string").join(" ").toLowerCase();
  return String(markdown ?? "").split("\n").filter((line) => line.trim().startsWith("|") && !line.includes("Business term") && !line.includes("---"))
    .map(parseMapping)
    .filter(Boolean)
    .filter((mapping) => Array.isArray(ticket.vocabulary_hints) ? hints.some((hint) => glossaryTermMatches(hint, mapping.businessTerm)) : glossaryTermMatchesText(text, mapping.businessTerm))
    .map((mapping) => mapping.raw);
}

// Normalizes explicit ticket vocabulary hints into comparable term strings.
function normalizeHints(value) {
  if (!Array.isArray(value)) return [];
  return value.map((hint) => typeof hint === "string" ? hint : hint?.business_term ?? hint?.term ?? hint?.businessTerm).filter(Boolean);
}

// Parses one glossary table row into its business term and original Markdown.
function parseMapping(line) {
  const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
  if (cells.length < 2) return null;
  return { businessTerm: cells[0], raw: `| ${cells.join(" | ")} |` };
}

// Checks an explicit hint against a full glossary term or its parenthesized base.
function glossaryTermMatches(left, right) {
  const normalizedLeft = String(left).trim().toLowerCase();
  const normalizedRight = String(right).trim().toLowerCase();
  const baseRight = normalizedRight.replace(/\s*\([^)]*\)\s*$/, "");
  return normalizedLeft === normalizedRight || normalizedLeft === baseRight;
}

// Checks ticket text against a full glossary term or its parenthesized base.
function glossaryTermMatchesText(text, term) {
  const normalizedTerm = String(term).trim().toLowerCase();
  const baseTerm = normalizedTerm.replace(/\s*\([^)]*\)\s*$/, "");
  return text.includes(normalizedTerm) || text.includes(baseTerm);
}

// Escapes a heading before it is inserted into a regular expression.
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Formats selected conventions and mappings as prompt-ready context.
function formatConventionContext(sections, mappings) {
  if (!sections.length && !mappings.length) return "";
  return [
    "Node-injected repository conventions for this ticket:",
    ...sections,
    ...(mappings.length ? ["Relevant vocabulary mappings:", ...mappings] : [])
  ].join("\n\n");
}
