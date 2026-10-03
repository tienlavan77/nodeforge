// Constrains Sprint Leader tickets to the work groups approved in a readable plan.
import { ConfigurationError } from "../../shared/errors.js";

// Reports a missing or expanded approved work group before Sprint persistence.
function fail(message) { return Object.assign(new ConfigurationError(message), { code: "SPRINT_MARKDOWN_SCOPE", statusCode: 422 }); }

// Compares reviewed work descriptions while ignoring harmless formatting punctuation.
function normalized(value) { return String(value ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").toLocaleLowerCase("en"); }

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

// Builds Sprint tickets from the owner-approved work groups while retaining leader-assigned IDs.
export function projectMarkdownSprintScope(markdown, sprint) {
  const approved = readMarkdownSprintScope(markdown);
  const tickets = sprint?.tickets;
  if (!Array.isArray(tickets) || tickets.length !== approved.length) throw fail("Sprint ticket count differs from approved Markdown work groups.");
  const ids = tickets.map((ticket) => ticket?.id);
  if (ids.some((id) => typeof id !== "string" || !/^TICKET-[A-Za-z0-9._-]+$/.test(id))) throw fail("Sprint Leader must create valid ticket IDs for every approved work group.");
  if (new Set(ids).size !== ids.length) throw fail("Sprint Leader ticket IDs must be unique.");
  const projected = approved.map((row, index) => {
    const dependencies = row.dependency_labels.flatMap((label) => {
      const prior = approved.findIndex((candidate, position) => position < index && (normalized(candidate.title) === normalized(label) || String(candidate.position) === label || normalized(`ticket ${candidate.position}`) === normalized(label)));
      if (prior >= 0) return [ids[prior]];
      if (/\b(decision|confirmation)$/i.test(label)) return [];
      throw fail(`Approved work group ${index + 1} has an unknown dependency.`);
    });
    const priority = tickets[index].priority;
    if (priority !== undefined && !["low", "medium", "normal", "high", "critical"].includes(priority)) throw fail(`Sprint ticket ${index + 1} has an invalid priority.`);
    return { id: ids[index], title: row.title, objective: row.objective, implementation_type: [row.implementation_type], file_budget: row.file_budget, acceptance_criteria: [...row.acceptance_criteria], dependencies, ...(priority === undefined ? {} : { priority }) };
  });
  const result = { ...sprint, tickets: projected };
  assertMarkdownSprintScope(markdown, result);
  return result;
}

// Rejects ticket scope or sequencing that differs from the approved work-group table.
export function assertMarkdownSprintScope(markdown, sprint) {
  const approved = readMarkdownSprintScope(markdown);
  const tickets = sprint?.tickets;
  if (!Array.isArray(tickets) || tickets.length !== approved.length) throw fail("Sprint ticket count differs from approved Markdown work groups.");
  for (let index = 0; index < approved.length; index += 1) {
    const ticket = tickets[index];
    const row = approved[index];
    const implementationType = ticket?.implementation_type?.length === 1 ? String(ticket.implementation_type[0]).trim().toLocaleLowerCase("en") : "";
    if (normalized(ticket?.title) !== normalized(row.title) || normalized(ticket?.objective) !== normalized(row.objective) || implementationType !== row.implementation_type || !Number.isInteger(ticket.file_budget) || ticket.file_budget > row.file_budget) throw fail(`Sprint ticket ${index + 1} changes an approved work-group title, objective, implementation type, or file budget.`);
    if (!Array.isArray(ticket.acceptance_criteria) || ticket.acceptance_criteria.length !== row.acceptance_criteria.length || row.acceptance_criteria.some((criterion, criterionIndex) => normalized(ticket.acceptance_criteria[criterionIndex]) !== normalized(criterion))) throw fail(`Sprint ticket ${index + 1} changes approved acceptance criteria.`);
    const expectedDependencies = row.dependency_labels.flatMap((label) => {
      const prior = approved.findIndex((candidate, position) => position < index && (normalized(candidate.title) === normalized(label) || String(candidate.position) === label || normalized(`ticket ${candidate.position}`) === normalized(label)));
      if (prior >= 0) return [tickets[prior].id];
      if (/\b(decision|confirmation)$/i.test(label)) return [];
      throw fail(`Approved work group ${index + 1} has an unknown dependency.`);
    });
    const actualDependencies = ticket.dependencies ?? [];
    if (!Array.isArray(actualDependencies) || expectedDependencies.length !== actualDependencies.length || expectedDependencies.some((id) => !actualDependencies.includes(id))) throw fail(`Sprint ticket ${index + 1} changes approved dependencies.`);
  }
  return approved;
}
