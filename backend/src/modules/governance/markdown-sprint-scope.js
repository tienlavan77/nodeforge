// Constrains Sprint tickets to approved work groups or outcome coverage in a readable plan.
import { splitMarkdownTableRow } from "./markdown-table-row.js";
import { ConfigurationError } from "../../shared/errors.js";
import { assertTicketVerificationContract } from "./ticket-verification-contract.js";

// Defines fail function behavior for markdown-sprint-scope.js.
function fail(message) { return Object.assign(new ConfigurationError(message), { code: "SPRINT_MARKDOWN_SCOPE", statusCode: 422 }); }
// Defines normalized function behavior for markdown-sprint-scope.js.
function normalized(value) { return String(value ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").toLocaleLowerCase("en"); }
// Reject unfinished plan template fields while preserving Markdown formatting and literal source examples.
function hasUnfilledPlaceholder(value) {
  const text = String(value ?? "")
    .replace(/(?:\b[A-Za-z_][A-Za-z0-9_.:/?=&%-]*|\/)<(?!(?:TBD|TODO|FIXME)>)[A-Za-z_][A-Za-z0-9_]*>/gi, "")
    .replace(/(`+)([\s\S]*?)\1/g, (span, delimiter, code) => /^\s*<[^>]+>\s*$/.test(code) && !/\/\s*>\s*$|=/.test(code) ? code : "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(?:br|p|div|span|strong|em|b|i|code|pre|ul|ol|li|a|img|details|summary|hr|sup|sub)(?:\s[^<>]*?)?\s*\/?\s*>/gi, "")
    .replace(/<(?:https?:\/\/|mailto:)[^<>\s]+>/gi, "");
  return /<[^>]+>/.test(text);
}

// Reads the approved Markdown contract without discarding outcome evidence.
export function readMarkdownSprintScope(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^## 5\. /.test(line));
  if (start < 0) throw fail("Approved Markdown requires a section 5 work-group table.");
  const end = lines.findIndex((line, index) => index > start && /^## 6\. /.test(line));
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  const rows = section.filter((line) => /^\|\s*\d+\s*\|/.test(line)).map(splitMarkdownTableRow);
  if (!rows.length) return readOutcomeRows(section);
  return rows.map((rawCells, index) => {
    const cells = rawCells.map((cell) => cell.replace(/[`*]/g, "").trim());
    const [position, title, implementationType, objective, dependencyText, budgetText, acceptanceText] = cells;
    const budget = Number(String(budgetText ?? "").match(/\b(\d+)\s*files?\b/i)?.[1]);
    const acceptanceCriteria = String(acceptanceText ?? "").split(";").map((value) => value.trim()).filter(Boolean);
    if (cells.length !== 7 || Number(position) !== index + 1 || !title || !objective || !dependencyText || !acceptanceCriteria.length || hasUnfilledPlaceholder(rawCells.join(" ")) || !["frontend", "backend", "security"].includes(implementationType) || !Number.isInteger(budget) || budget < 1) throw fail(`Approved Markdown work group ${index + 1} is incomplete or invalid.`);
    return { position: index + 1, title, objective, dependency_labels: /^[—–-]$|^none$/i.test(dependencyText) ? [] : dependencyText.split(/[,;]/).map((value) => value.trim()), implementation_type: implementationType, file_budget: budget, acceptance_criteria: acceptanceCriteria };
  });
}

// Projects approved scope while retaining all outcome proof needed at handoff.
export function projectMarkdownSprintScope(markdown, sprint) {
  const projected = normalizeMarkdownSprintScope(markdown, sprint);
  assertMarkdownSprintScope(markdown, projected);
  return projected;
}

// Freezes approved criteria before verification admission so owner retries use stable positional AC IDs.
export function normalizeMarkdownSprintScope(markdown, sprint) {
  const approved = readMarkdownSprintScope(markdown);
  if (approved[0]?.kind === "outcome") {
    const tickets = Array.isArray(sprint?.tickets) ? sprint.tickets : [];
    const projectedTickets = tickets.map((ticket) => bindApprovedOutcomeCoverage(ticket, approved, tickets));
    const projected = { ...sprint, tickets: projectedTickets };
    delete projected.outcome_coverage;
    return projected;
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
    return { id: ids[index], title: row.title, objective: row.objective, implementation_type: [row.implementation_type], file_budget: row.file_budget, acceptance_criteria: [...row.acceptance_criteria], verification_plan: structuredClone(tickets[index].verification_plan), dependencies, ...(priority === undefined ? {} : { priority }) };
  });
  return { ...sprint, tickets: projected };
}

// Business purpose: resolves positional criterion/guardrail IDs (O<n>.AC-<i>, O<n>.G-<j>) or text into canonical Owner wording.
// Technical description: maps each reference to { id, text } when matched against the outcome's positional entries, or retains { id: null, text: raw } for invalid references so admission rejects them.
function resolveOutcomeEntries(refs, entries) {
  return refs.map((ref) => {
    const raw = String(ref ?? "").trim();
    return entries.find((entry) => entry.id.toUpperCase() === raw.toUpperCase() || normalized(entry.text) === normalized(raw)) ?? { id: null, text: raw };
  });
}

// Binds approved criteria, guardrails, and mandatory dependencies to each ticket after semantic checks.
function bindApprovedOutcomeCoverage(ticket, outcomes, allTickets = []) {
  if (!ticket || typeof ticket !== "object" || !Array.isArray(ticket.outcome_refs)) return ticket;
  const copy = { ...structuredClone(ticket), ...(Array.isArray(ticket.implementation_type) ? { implementation_type: [...ticket.implementation_type] } : {}), ...(Array.isArray(ticket.acceptance_criteria) ? { acceptance_criteria: [...ticket.acceptance_criteria] } : {}), dependencies: Array.isArray(ticket.dependencies) ? [...ticket.dependencies] : [], outcome_refs: [...ticket.outcome_refs] };
  const coverage = { ...(copy.coverage ?? {}) };
  for (const outcomeId of copy.outcome_refs) {
    const outcome = outcomes.find((item) => item.id === outcomeId);
    if (!outcome) continue;
    const declared = coverage[outcomeId] ?? {};
    const hasCriteria = Object.hasOwn(declared, "criterion_refs") || Object.hasOwn(declared, "criteria_refs") || Object.hasOwn(copy.criterion_refs ?? {}, outcomeId);
    const hasGuardrail = Object.hasOwn(declared, "guardrail_refs") || Object.hasOwn(copy.guardrail_refs ?? {}, outcomeId);
    const hasDep = Object.hasOwn(declared, "dependency_refs") || Object.hasOwn(copy.dependency_refs ?? {}, outcomeId);
    const rawCriteria = declared.criterion_refs ?? declared.criteria_refs ?? copy.criterion_refs?.[outcomeId];
    const rawGuardrails = declared.guardrail_refs ?? copy.guardrail_refs?.[outcomeId];
    const rawDeps = declared.dependency_refs ?? copy.dependency_refs?.[outcomeId];
    if ((hasCriteria && !Array.isArray(rawCriteria)) || (hasGuardrail && !Array.isArray(rawGuardrails)) || (hasDep && !Array.isArray(rawDeps))) continue;
    const isSingleTicketForOutcome = allTickets.filter((candidate) => Array.isArray(candidate?.outcome_refs) && candidate.outcome_refs.includes(outcomeId)).length <= 1;
    const isLegacySingle = isSingleTicketForOutcome && !hasCriteria && !hasGuardrail;
    const matchedAc = (copy.acceptance_criteria ?? []).filter((item) => resolveOutcomeEntries([item], outcome.criterion_entries)[0]?.id);
    if (!hasCriteria && !matchedAc.length && isLegacySingle && Array.isArray(copy.acceptance_criteria)) {
      copy.acceptance_criteria.push(...outcome.acceptance_criteria.filter((criterion) => !copy.acceptance_criteria.some((item) => normalized(item) === normalized(criterion))));
    }
    const criterionRefs = hasCriteria ? resolveOutcomeEntries(rawCriteria, outcome.criterion_entries).map((entry) => entry.text) : matchedAc.length ? resolveOutcomeEntries(matchedAc, outcome.criterion_entries).map((entry) => entry.text) : isLegacySingle ? [...outcome.acceptance_criteria] : [];
    const guardrailRefs = hasGuardrail ? resolveOutcomeEntries(rawGuardrails, outcome.guardrail_entries).map((entry) => entry.text) : [...outcome.guardrails];
    const nextDeclared = { ...declared, criterion_refs: criterionRefs, guardrail_refs: guardrailRefs, ...(hasDep ? { dependency_refs: [...rawDeps] } : isSingleTicketForOutcome && !(Array.isArray(ticket.dependencies) && !ticket.dependencies.length && outcome.mandatory_dependencies.length) ? { dependency_refs: [...outcome.mandatory_dependencies] } : {}) };
    delete nextDeclared.criteria_refs;
    coverage[outcomeId] = nextDeclared;
  }
  return { ...copy, coverage };
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
    assertApprovedVerificationPlan(ticket, index + 1);
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

// Routes unsupported Owner verification prerequisites through the existing
// verification-only SL correction before Sprint ingestion wraps the error. This
// preserves approved criteria and never recasts missing proof as policy approval.
function assertApprovedVerificationPlan(ticket, label) {
  if (ticket.verification_plan === undefined) return;
  try {
    assertTicketVerificationContract(ticket);
    if (ticket.verification_plan.some((step) => step.kind === "human")) throw new ConfigurationError("kind human requires a new Owner prerequisite and cannot execute under an already approved Architecture plan. Supply executable test/browser evidence for behavior; record independent Reviewer and deployment limitations in notes. Do not replace missing behavior evidence with governance approval.");
  } catch (error) { throw fail(`Sprint ticket ${label} has an invalid verification plan: ${error.message}`); }
}

// Business purpose: splits a rendered Markdown table cell into individual acceptance criteria or guardrails without fragmenting parenthesized CSS/JS snippets (such as (display: inline-flex; padding: 0)) into extra artificial criteria.
// Technical description: splits on ".; " item boundaries when rendered from multi-sentence JSON items, or falls back to splitting on semicolons only at top-level parenthesis depth (depth === 0) when a single item contains parenthesized semicolons.
function splitOutcomeCellItems(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  if (text.includes(".;")) {
    const bySentenceDelimiter = text.split(/\.\s*;\s*/).map((item, index, arr) => {
      const trimmed = item.trim();
      if (!trimmed) return "";
      return index < arr.length - 1 && !trimmed.endsWith(".") ? `${trimmed}.` : trimmed;
    }).filter(Boolean);
    if (bySentenceDelimiter.length > 1) return bySentenceDelimiter;
  }
  const items = [];
  let current = "";
  let parenDepth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") parenDepth += 1;
    else if (ch === ")" && parenDepth > 0) parenDepth -= 1;
    if (ch === ";" && parenDepth === 0) {
      if (current.trim()) items.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

// Parses outcome identities, criteria, guardrails, and mandatory dependencies as durable scope.
function readOutcomeRows(lines) {
  const rows = lines.filter((line) => /^\|\s*O[1-9][0-9]*\s*\|/i.test(line)).map(splitMarkdownTableRow);
  if (!rows.length) throw fail("Approved Markdown section 5 needs an outcome table or ordered work groups.");
  const outcomes = rows.map((rawCells) => {
    const cells = rawCells.map((cell) => cell.replace(/[`*]/g, "").trim());
    const [id, outcome, acceptance, guardrailText = "", dependencyText = ""] = cells;
    const outcomeId = String(id ?? "").toUpperCase();
    const acceptanceCriteria = splitOutcomeCellItems(acceptance);
    const rawGuardrails = splitOutcomeCellItems(guardrailText).filter((item) => item && !/^[—–-]$|^none$/i.test(item));
    const mandatoryDependencies = String(dependencyText).split(/[,;]/).map((item) => item.trim().toUpperCase()).filter((item) => item && !/^[—–-]$|^NONE$/i.test(item));
    const guardrails = cells.length === 4 ? rawGuardrails.filter((item) => !/^O[1-9][0-9]*$/i.test(item)) : rawGuardrails;
    if ((cells.length !== 4 && cells.length !== 5) || !/^O[1-9][0-9]*$/i.test(id) || !outcome || !acceptanceCriteria.length || (cells.length === 5 ? !guardrails.length : !String(guardrailText).trim()) || hasUnfilledPlaceholder(rawCells.join(" "))) throw fail(`Approved outcome ${id ?? "?"} is incomplete.`);
    if (cells.length === 4 && rawGuardrails.some((item) => /^O[1-9][0-9]*$/i.test(item))) mandatoryDependencies.push(...rawGuardrails.filter((item) => /^O[1-9][0-9]*$/i.test(item)).map((item) => item.toUpperCase()));
    return { kind: "outcome", id: outcomeId, outcome, acceptance_criteria: acceptanceCriteria, criterion_entries: acceptanceCriteria.map((text, index) => ({ id: `${outcomeId}.AC-${index + 1}`, text })), guardrails, guardrail_entries: guardrails.map((text, index) => ({ id: `${outcomeId}.G-${index + 1}`, text })), mandatory_dependencies: mandatoryDependencies };
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
  return { criteria, guardrails, dependencies, dependency_declared: Object.hasOwn(declared, "dependency_refs") || Object.hasOwn(ticket.dependency_refs ?? {}, outcome.id) };
}

// Verifies every approved outcome element and the dependency graph before admission.
function assertOutcomeSprintScope(outcomes, sprint) {
  const rawTickets = sprint?.tickets;
  if (!Array.isArray(rawTickets) || !rawTickets.length) throw fail("Sprint Leader must map approved outcomes to tickets.");
  const tickets = rawTickets.map((ticket) => bindApprovedOutcomeCoverage(ticket, outcomes, rawTickets));
  const ids = tickets.map((ticket) => ticket?.id);
  if (ids.some((id) => typeof id !== "string" || !/^TICKET-[A-Za-z0-9._-]+$/.test(id)) || new Set(ids).size !== ids.length) throw fail("Sprint tickets need unique TICKET-* IDs.");
  const codes = new Set(outcomes.map((outcome) => outcome.id));
  const coveredCriteria = new Map(outcomes.map((outcome) => [outcome.id, new Set()]));
  const coveredGuardrails = new Map(outcomes.map((outcome) => [outcome.id, new Set()]));
  const coveredDeps = new Map(outcomes.map((outcome) => [outcome.id, new Set()]));
  const covered = new Set();
  const edges = new Map(ids.map((id) => [id, []]));
  for (const ticket of tickets) {
    if (typeof ticket.title !== "string" || !ticket.title.trim() || typeof ticket.objective !== "string" || !ticket.objective.trim() || !Array.isArray(ticket.implementation_type) || ticket.implementation_type.length !== 1 || !["frontend", "backend", "security"].includes(ticket.implementation_type[0]) || !Number.isInteger(ticket.file_budget) || ticket.file_budget < 1 || !Array.isArray(ticket.acceptance_criteria) || !ticket.acceptance_criteria.length || ticket.acceptance_criteria.some((item) => typeof item !== "string" || !item.trim())) throw fail(`Sprint ticket ${ticket.id} is incomplete or has an invalid file budget.`);
    assertApprovedVerificationPlan(ticket, ticket.id);
    if (!Array.isArray(ticket.outcome_refs) || !ticket.outcome_refs.length || ticket.outcome_refs.some((code) => !codes.has(code)) || new Set(ticket.outcome_refs).size !== ticket.outcome_refs.length) throw fail(`Sprint ticket ${ticket.id} must cite approved outcome IDs.`);
    for (const code of ticket.outcome_refs) {
      const outcome = outcomes.find((item) => item.id === code);
      const coverage = coverageFor(ticket, outcome);
      const resolvedAc = resolveOutcomeEntries(coverage.criteria, outcome.criterion_entries);
      if (!resolvedAc.length || resolvedAc.some((entry) => !entry.id)) throw fail(`Sprint ticket ${ticket.id} ${resolvedAc.find((entry) => !entry.id) ? `cites invalid criterion ${resolvedAc.find((entry) => !entry.id).text}` : "omits approved criteria"} for ${code}.`);
      for (const entry of resolvedAc) coveredCriteria.get(code).add(entry.id);
      const resolvedG = resolveOutcomeEntries(coverage.guardrails, outcome.guardrail_entries);
      if (resolvedG.some((entry) => !entry.id)) throw fail(`Sprint ticket ${ticket.id} cites invalid guardrail ${resolvedG.find((entry) => !entry.id).text} for ${code}.`);
      for (const entry of resolvedG) coveredGuardrails.get(code).add(entry.id);
      const graphDeps = (ticket.dependencies ?? []).flatMap((depId) => tickets.find((candidate) => candidate.id === depId)?.outcome_refs ?? []).filter((depCode) => depCode !== code);
      const depRefs = coverage.dependency_declared ? coverage.dependencies : graphDeps;
      if (depRefs.some((dep) => !outcome.mandatory_dependencies.includes(dep))) throw fail(`Sprint ticket ${ticket.id} weakens mandatory dependencies for ${code}.`);
      for (const dep of [...depRefs, ...graphDeps]) if (outcome.mandatory_dependencies.includes(dep)) coveredDeps.get(code).add(dep);
      covered.add(code);
    }
    if (ticket.dependencies !== undefined && (!Array.isArray(ticket.dependencies) || ticket.dependencies.some((id) => !ids.includes(id) || id === ticket.id))) throw fail(`Sprint ticket ${ticket.id} has an invalid dependency.`);
    edges.set(ticket.id, ticket.dependencies ?? []);
  }
  if ([...codes].some((code) => !covered.has(code))) throw fail("Sprint tickets do not cover every approved outcome.");
  for (const outcome of outcomes) {
    const missing = [...outcome.criterion_entries.filter((entry) => !coveredCriteria.get(outcome.id).has(entry.id)).map((entry) => entry.id), ...outcome.guardrail_entries.filter((entry) => !coveredGuardrails.get(outcome.id).has(entry.id)).map((entry) => entry.id)];
    if (missing.length) throw fail(`Sprint tickets omit approved coverage for ${outcome.id}: ${missing.join(", ")}.`);
    const missingDeps = outcome.mandatory_dependencies.filter((dep) => !coveredDeps.get(outcome.id).has(dep) || !tickets.some((ticket) => ticket.outcome_refs?.includes(dep)));
    if (missingDeps.length) throw fail(`Sprint tickets weaken mandatory dependencies for ${outcome.id}: missing ${missingDeps.join(", ")}.`);
  }
  if (hasDependencyCycle(edges)) throw fail("Sprint ticket dependencies must be acyclic.");
  return outcomes;
}

// Detects dependency cycles before Sprint Plan admission.
function hasDependencyCycle(edges) {
  const visiting = new Set();
  const visited = new Set();
  // Defines visit function behavior for markdown-sprint-scope.js.
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
