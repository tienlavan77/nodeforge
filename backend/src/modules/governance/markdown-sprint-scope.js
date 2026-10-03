// Constrains Sprint Leader tickets to the work groups approved in a readable plan.
import { ConfigurationError } from "../../shared/errors.js";

// Reports a missing or expanded approved work group before Sprint persistence.
function fail(message) { return Object.assign(new ConfigurationError(message), { code: "SPRINT_MARKDOWN_SCOPE", statusCode: 422 }); }

// Compares reviewed work descriptions despite harmless case and spacing differences.
function normalized(value) { return String(value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en"); }

// Extracts the ordered work groups from section 5 of an owner-reviewed Markdown plan.
export function readMarkdownSprintScope(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^## 5\. /.test(line));
  if (start < 0) throw fail("Approved Markdown requires a section 5 work-group table.");
  const end = lines.findIndex((line, index) => index > start && /^## 6\. /.test(line));
  const rows = lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => /^\|\s*\d+\s*\|/.test(line)).map((line) => line.split("|").slice(1, -1).map((cell) => cell.replace(/[`*]/g, "").trim()));
  if (!rows.length) throw fail("Approved Markdown has no ordered work groups.");
  return rows.map((cells, index) => {
    const [position, title, implementationType, objective, dependencyText, budgetText, acceptanceText] = cells;
    const budget = Number(String(budgetText ?? "").match(/\b(\d+)\s*files?\b/i)?.[1]);
    const acceptanceCriteria = String(acceptanceText ?? "").split(";").map((value) => value.trim()).filter(Boolean);
    if (cells.length !== 7 || Number(position) !== index + 1 || !title || !objective || !dependencyText || !acceptanceCriteria.length || /<[^>]+>/.test(`${title} ${objective} ${dependencyText} ${acceptanceText}`) || !["frontend", "backend", "security"].includes(implementationType) || !Number.isInteger(budget) || budget < 1 || budget > 4) throw fail(`Approved Markdown work group ${index + 1} is incomplete or invalid.`);
    return { position: index + 1, title, objective, dependency_labels: /^[—–-]$|^none$/i.test(dependencyText) ? [] : dependencyText.split(/[,;]/).map((value) => value.trim()), implementation_type: implementationType, file_budget: budget, acceptance_criteria: acceptanceCriteria };
  });
}

// Rejects ticket scope or sequencing that differs from the approved work-group table.
export function assertMarkdownSprintScope(markdown, sprint) {
  const approved = readMarkdownSprintScope(markdown);
  const tickets = sprint?.tickets;
  if (!Array.isArray(tickets) || tickets.length !== approved.length) throw fail("Sprint ticket count differs from approved Markdown work groups.");
  for (let index = 0; index < approved.length; index += 1) {
    const ticket = tickets[index];
    const row = approved[index];
    if (normalized(ticket?.title) !== normalized(row.title) || normalized(ticket?.objective) !== normalized(row.objective) || ticket?.implementation_type?.length !== 1 || ticket.implementation_type[0] !== row.implementation_type || !Number.isInteger(ticket.file_budget) || ticket.file_budget > row.file_budget) throw fail(`Sprint ticket ${index + 1} changes an approved work-group title, objective, implementation type, or file budget.`);
    if (!Array.isArray(ticket.acceptance_criteria) || ticket.acceptance_criteria.length !== row.acceptance_criteria.length || row.acceptance_criteria.some((criterion, criterionIndex) => normalized(ticket.acceptance_criteria[criterionIndex]) !== normalized(criterion))) throw fail(`Sprint ticket ${index + 1} changes approved acceptance criteria.`);
    const expectedDependencies = row.dependency_labels.map((label) => {
      const prior = approved.findIndex((candidate, position) => position < index && (normalized(candidate.title) === normalized(label) || String(candidate.position) === label || normalized(`ticket ${candidate.position}`) === normalized(label)));
      if (prior < 0) throw fail(`Approved work group ${index + 1} has an unknown dependency.`);
      return tickets[prior].id;
    });
    const actualDependencies = ticket.dependencies ?? [];
    if (!Array.isArray(actualDependencies) || expectedDependencies.length !== actualDependencies.length || expectedDependencies.some((id) => !actualDependencies.includes(id))) throw fail(`Sprint ticket ${index + 1} changes approved dependencies.`);
  }
  return approved;
}
