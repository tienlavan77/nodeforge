// Constrains Sprint tickets to approved work groups or outcome coverage in a readable plan.
import { ConfigurationError } from "../../shared/errors.js";

function fail(message) { return Object.assign(new ConfigurationError(message), { code: "SPRINT_MARKDOWN_SCOPE", statusCode: 422 }); }
function normalized(value) { return String(value ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").toLocaleLowerCase("en"); }
function hasUnfilledPlaceholder(value) { return /<[^>]+>/.test(String(value ?? "").replace(/\bSUMMARY-<uuid>/g, "")); }

// Reads the approved Markdown contract without discarding outcome evidence.
export function readMarkdownSprintScope(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^## 5\. /.test(line));
  if (start < 0) throw fail("Approved Markdown requires a section 5 work-group table.");
  const end = lines.findIndex((line, index) => index > start && /^## 6\. /.test(line));
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  const rows = section.filter((line) => /^\|\s*\d+\s*\|/.test(line)).map((line) => line.split("|").slice(1, -1).map((cell) => cell.replace(/[`*]/g, "").trim()));
  if (!rows.length) return readOutcomeRows(section);
  return rows.map((cells, index) => {
    const [position, title, implementationType, objective, dependencyText, budgetText, acceptanceText] = cells;
    const budget = Number(String(budgetText ?? "").match(/\b(\d+)\s*files?\b/i)?.[1]);
    const acceptanceCriteria = String(acceptanceText ?? "").split(";").map((value) => value.trim()).filter(Boolean);
    if (cells.length !== 7 || Number(position) !== index + 1 || !title || !objective || !dependencyText || !acceptanceCriteria.length || hasUnfilledPlaceholder(cells.join(" ")) || !["frontend", "backend", "security"].includes(implementationType) || !Number.isInteger(budget) || budget < 1 || budget > 4) throw fail(`Approved Markdown work group ${index + 1} is incomplete or invalid.`);
    return { position: index + 1, title, objective, dependency_labels: /^[—–-]$|^none$/i.test(dependencyText) ? [] : dependencyText.split(/[,;]/).map((value) => value.trim()), implementation_type: implementationType, file_budget: budget, acceptance_criteria: acceptanceCriteria };
  });
}

// Projects approved scope while retaining all outcome proof needed at handoff.
export function projectMarkdownSprintScope(markdown, sprint) {
  const approved = readMarkdownSprintScope(markdown);
  if (approved[0]?.kind === "outcome") {
    assertOutcomeSprintScope(approved, sprint);
    return { ...sprint, outcome_coverage: structuredClone(approved), tickets: sprint.tickets.map((ticket) => ({ ...structuredClone(ticket), implementation_type: [...ticket.implementation_type], acceptance_criteria: [...ticket.acceptance_criteria], dependencies: [...(ticket.dependencies ?? [])], outcome_refs: [...ticket.outcome_refs], ...(ticket.coverage ? { coverage: structuredClone(ticket.coverage) } : {}), ...(ticket.criterion_refs ? { criterion_refs: structuredClone(ticket.criterion_refs) } : {}), ...(ticket.guardrail_refs ? { guardrail_refs: structuredClone(ticket.guardrail_refs) } : {}), ...(ticket.dependency_refs ? { dependency_refs: structuredClone(ticket.dependency_refs) } : {}) })) };
  }
  const tickets = sprint?.tickets;
  if (!Array.isArray(tickets) || tickets.length !== approved.length) throw fail("Sprint ticket count differs from approved Markdown work groups.");
  const ids = tickets.map((ticket) => ticket?.id);
  if (ids.some((id) => typeof id !== "string" || !/^TICKET-[A-Za-z0-9._-]+$/.test(id)) || new Set(ids).size !== ids.length) throw fail("Sprint Leader must create unique valid ticket IDs.");
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

// Admits only tickets that preserve the approved legacy table or complete outcome proof.
export function assertMarkdownSprintScope(markdown, sprint) {
  const approved = readMarkdownSprintScope(markdown);
  if (approved[0]?.kind === "outcome") return assertOutcomeSprintScope(approved, sprint);
  const tickets = sprint?.tickets;
  if (!Array.isArray(tickets) || tickets.length !== approved.length) throw fail("Sprint ticket count differs from approved Markdown work groups.");
  for (let index = 0; index < approved.length; index += 1) {
    const ticket = tickets[index];
    const row = approved[index];
    const implementationType = ticket?.implementation_type?.length === 1 ? String(ticket.implementation_type[0]).trim().toLocaleLowerCase("en") : "";
    if (normalized(ticket?.title) !== normalized(row.title) || normalized(ticket?.objective) !== normalized(row.objective) || implementationType !== row.implementation_type || !Number.isInteger(ticket.file_budget) || ticket.file_budget < 1 || ticket.file_budget > row.file_budget) throw fail(`Sprint ticket ${index + 1} changes approved boundaries.`);
    if (!Array.isArray(ticket.acceptance_criteria) || ticket.acceptance_criteria.length !== row.acceptance_criteria.length || row.acceptance_criteria.some((criterion, criterionIndex) => normalized(ticket.acceptance_criteria[criterionIndex]) !== normalized(criterion))) throw fail(`Sprint ticket ${index + 1} changes approved acceptance criteria.`);
    const expected = row.dependency_labels.flatMap((label) => {
      const prior = approved.findIndex((candidate, position) => position < index && (normalized(candidate.title) === normalized(label) || String(candidate.position) === label || normalized(`ticket ${candidate.position}`) === normalized(label)));
      if (prior >= 0) return [tickets[prior].id];
      if (/\b(decision|confirmation)$/i.test(label)) return [];
      throw fail(`Approved work group ${index + 1} has an unknown dependency.`);
    });
    const actual = ticket.dependencies ?? [];
    if (!Array.isArray(actual) || expected.length !== actual.length || expected.some((id) => !actual.includes(id))) throw fail(`Sprint ticket ${index + 1} changes approved dependencies.`);
  }
  return approved;
}

// Parses outcome identities, criteria, guardrails, and mandatory dependencies as durable scope.
function readOutcomeRows(lines) {
  const rows = lines.filter((line) => /^\|\s*O[1-9][0-9]*\s*\|/i.test(line)).map((line) => line.split("|").slice(1, -1).map((cell) => cell.replace(/[`*]/g, "").trim()));
  if (!rows.length) throw fail("Approved Markdown section 5 needs an outcome table or ordered work groups.");
  const outcomes = rows.map((cells) => {
    const [id, outcome, acceptance, guardrailText = "", dependencyText = ""] = cells;
    const acceptanceCriteria = String(acceptance ?? "").split(";").map((item) => item.trim()).filter(Boolean);
    const rawGuardrails = String(guardrailText).split(";").map((item) => item.trim()).filter((item) => !/^[—–-]$|^none$/i.test(item));
    const mandatoryDependencies = String(dependencyText).split(/[,;]/).map((item) => item.trim()).filter(Boolean);
    const guardrails = cells.length === 4 ? rawGuardrails.filter((item) => !/^O[1-9][0-9]*$/i.test(item)) : rawGuardrails;
    if ((cells.length !== 4 && cells.length !== 5) || !/^O[1-9][0-9]*$/i.test(id) || !outcome || !acceptanceCriteria.length || hasUnfilledPlaceholder(cells.join(" "))) throw fail(`Approved outcome ${id ?? "?"} is incomplete.`);
    if (cells.length === 4 && rawGuardrails.some((item) => /^O[1-9][0-9]*$/i.test(item))) mandatoryDependencies.push(...rawGuardrails.filter((item) => /^O[1-9][0-9]*$/i.test(item)).map((item) => item.toUpperCase()));
    return { kind: "outcome", id: id.toUpperCase(), outcome, acceptance_criteria: acceptanceCriteria, guardrails, mandatory_dependencies: mandatoryDependencies };
  });
  if (new Set(outcomes.map((item) => item.id)).size !== outcomes.length) throw fail("Approved outcomes need unique IDs.");
  return outcomes;
}

// Preserves valid ticket coverage declarations during handoff.
function coverageFor(ticket, outcome) {
  const declared = ticket.coverage?.[outcome.id] ?? {};
  const criteria = declared.criterion_refs ?? declared.criteria_refs ?? ticket.criterion_refs?.[outcome.id] ?? [];
  const guardrails = declared.guardrail_refs ?? ticket.guardrail_refs?.[outcome.id] ?? [];
  const dependencies = declared.dependency_refs ?? ticket.dependency_refs?.[outcome.id] ?? [];
  if (![criteria, guardrails, dependencies].every(Array.isArray)) throw fail(`Sprint ticket ${ticket.id} has invalid outcome coverage.`);
  return { criteria, guardrails, dependencies };
}

// Verifies every approved outcome element and the dependency graph before admission.
function assertOutcomeSprintScope(outcomes, sprint) {
  const tickets = sprint?.tickets;
  if (!Array.isArray(tickets) || !tickets.length) throw fail("Sprint Leader must map approved outcomes to tickets.");
  const ids = tickets.map((ticket) => ticket?.id);
  if (ids.some((id) => typeof id !== "string" || !/^TICKET-[A-Za-z0-9._-]+$/.test(id)) || new Set(ids).size !== ids.length) throw fail("Sprint tickets need unique TICKET-* IDs.");
  const codes = new Set(outcomes.map((outcome) => outcome.id));
  const covered = new Set();
  const edges = new Map(ids.map((id) => [id, []]));
  for (const ticket of tickets) {
    if (typeof ticket.title !== "string" || !ticket.title.trim() || typeof ticket.objective !== "string" || !ticket.objective.trim() || !Array.isArray(ticket.implementation_type) || ticket.implementation_type.length !== 1 || !["frontend", "backend", "security"].includes(ticket.implementation_type[0]) || !Number.isInteger(ticket.file_budget) || ticket.file_budget < 1 || ticket.file_budget > 4 || !Array.isArray(ticket.acceptance_criteria) || !ticket.acceptance_criteria.length || ticket.acceptance_criteria.some((item) => typeof item !== "string" || !item.trim())) throw fail(`Sprint ticket ${ticket.id} is incomplete or exceeds its file budget.`);
    if (!Array.isArray(ticket.outcome_refs) || !ticket.outcome_refs.length || ticket.outcome_refs.some((code) => !codes.has(code)) || new Set(ticket.outcome_refs).size !== ticket.outcome_refs.length) throw fail(`Sprint ticket ${ticket.id} must cite approved outcome IDs.`);
    for (const code of ticket.outcome_refs) {
      const outcome = outcomes.find((item) => item.id === code);
      const coverage = coverageFor(ticket, outcome);
      const criteria = coverage.criteria.length ? coverage.criteria : ticket.acceptance_criteria.filter((item) => outcome.acceptance_criteria.some((approved) => normalized(approved) === normalized(item)));
      const guardrails = coverage.guardrails.length ? coverage.guardrails : ticket.guardrail_refs?.filter((item) => outcome.guardrails.some((approved) => normalized(approved) === normalized(item))) ?? [];
      if (criteria.length !== outcome.acceptance_criteria.length || outcome.acceptance_criteria.some((item) => !criteria.some((ref) => normalized(ref) === normalized(item))) || guardrails.length !== outcome.guardrails.length || outcome.guardrails.some((item) => !guardrails.some((ref) => normalized(ref) === normalized(item)))) throw fail(`Sprint ticket ${ticket.id} omits approved criteria or guardrails for ${code}.`);
      const dependencyRefs = coverage.dependencies.length ? coverage.dependencies : (ticket.dependencies ?? []).flatMap((dependencyId) => tickets.find((candidate) => candidate.id === dependencyId)?.outcome_refs ?? []);
      if (dependencyRefs.length !== outcome.mandatory_dependencies.length || outcome.mandatory_dependencies.some((item) => !dependencyRefs.includes(item))) throw fail(`Sprint ticket ${ticket.id} weakens mandatory dependencies for ${code}.`);
      covered.add(code);
    }
    if (ticket.dependencies !== undefined && (!Array.isArray(ticket.dependencies) || ticket.dependencies.some((id) => !ids.includes(id) || id === ticket.id))) throw fail(`Sprint ticket ${ticket.id} has an invalid dependency.`);
    edges.set(ticket.id, ticket.dependencies ?? []);
  }
  if ([...codes].some((code) => !covered.has(code))) throw fail("Sprint tickets do not cover every approved outcome.");
  if ([...outcomes].some((outcome) => outcome.mandatory_dependencies.some((dependency) => !tickets.some((ticket) => ticket.dependencies?.includes(dependency) || ticket.outcome_refs?.includes(dependency)))) throw fail("Sprint tickets weaken mandatory outcome dependencies.");
  if (hasDependencyCycle(edges)) throw fail("Sprint ticket dependencies must be acyclic.");
  return outcomes;
}

// Detects dependency cycles before Sprint Plan admission.
function hasDependencyCycle(edges) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((edges.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return [...edges.keys()].some(visit);
}
