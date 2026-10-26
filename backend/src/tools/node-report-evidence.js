// Derives ticket report facts from immutable Node verification evidence.
import { findPassingVerificationCommand } from "./verification-command-evidence.js";
import { hasOwnerDecisionEvidence } from "../modules/governance/plan-decision-requests.js";

// Adds source, command, and scope facts without claiming unproven behavior passed.
export function completeNodeReportEvidence(input, ticket, artifact) {
  const changed = [...(artifact.changed_paths ?? Object.keys(artifact.file_checksums ?? {}))].sort();
  const unchanged = Object.keys(artifact.file_checksums ?? {}).filter((path) => !changed.includes(path)).sort();
  const criteria = ticket.acceptance_criteria ?? [];
  const coverage = completeCoverage(input.acceptance_coverage, criteria, artifact.commands ?? [], ticket?.verification_plan, ticket);
  const evidence = Array.isArray(input.evidence) && input.evidence.length ? input.evidence : [
    { type: "verification", reference: artifact.artifact_id, result: "passed" },
    ...(artifact.commands ?? []).map((command) => ({ type: "command", reference: command.output_sha256 ?? artifact.artifact_id, result: `${command.kind}: exit ${command.exit_code}${command.disposition === "preexisting_failure" ? `; supplemental preexisting failure reproduced at baseline ${command.baseline.commit_sha}, excluded from ticket responsibility` : ""}` }))
  ];
  return {
    ...input,
    acceptance_criteria: [...criteria],
    acceptance_coverage: coverage,
    implementation_scope: {
      changed_files: changed,
      not_changed_files: unchanged,
      scope_rationale: input.implementation_scope?.scope_rationale?.trim() || "Node recorded the committed ticket delta and unchanged manifest paths."
    },
    evidence
  };
}

// Retains Coder-supplied evidence and fills omitted criteria with conservative Node evidence.
function completeCoverage(supplied, criteria, commands, verificationPlan, ticket) {
  if (Array.isArray(verificationPlan) && verificationPlan.length) return coverageFromPlan(criteria, commands, verificationPlan, ticket, supplied);
  const entries = Array.isArray(supplied) ? [...supplied] : [];
  const covered = new Set(entries.map((entry) => criterionIndex(entry, criteria)).filter((index) => index >= 0));
  for (let index = 0; index < criteria.length; index += 1) {
    if (!covered.has(index)) entries.push(commandCoverage(criteria[index], index, commands));
  }
  return entries;
}

/** Derives coverage from every required approved check and its immutable receipt.
 * Both report completion and validation use this contract so command order and
 * criterion language cannot turn valid Node evidence into a rejected report. */
export function coverageFromPlan(criteria, commands, verificationPlan, ticket, supplied) {
  return criteria.map((criterion, index) => {
    const criterionId = `AC-${index + 1}`;
    const steps = verificationPlan.filter((step) => step.criterion_ids?.includes(criterionId));
    const ownerApproved = hasOwnerDecisionEvidence(ticket, criterionId);
    const hint = (supplied ?? []).find((entry) => criterionIndex(entry, criteria) === index);
    const hintPath = hint?.test_path ?? (hint?.missing_checks?.length === 1 && ["test", "backend_tests"].includes(hint.missing_checks[0].kind) ? hint.missing_checks[0].test_path : undefined);
    const required = steps.filter((step) => step.kind !== "governance" && !(step.kind === "human" && ownerApproved))
      .map((step) => ["test", "backend_tests"].includes(step.kind) && !step.test_path && typeof hintPath === "string"
        ? { ...step, test_path: hintPath } : step);
    const missing = required.filter((step) => (["test", "backend_tests"].includes(step.kind) && !step.test_path) || !findPassingVerificationCommand(step, commands));
    if (missing.length) return { criterion_id: criterionId, criterion, status: "evidence_pending", command_kind: hint?.command_kind ?? null, test_path: hintPath ?? null, missing_checks: missing.map((step) => ({ kind: step.kind, ...(step.test_path ? { test_path: step.test_path } : {}) })) };
    const passing = required.find((step) => ["test", "backend_tests", "browser"].includes(step.kind)) ?? required[0];
    if (passing) return { criterion_id: criterionId, criterion, status: "verified", command_kind: findPassingVerificationCommand(passing, commands).kind, ...(passing.test_path ? { test_path: passing.test_path } : {}),
      ...(required.length > 1 ? { verified_checks: required.map((step) => {
        const command = findPassingVerificationCommand(step, commands);
        return { kind: step.kind, command_kind: command.kind, ...(step.test_path ? { test_path: step.test_path } : {}), ...(command.output_sha256 ? { output_sha256: command.output_sha256 } : {}) };
      }) } : {}) };
    if (ownerApproved && steps.some((step) => step.kind === "human")) return { criterion_id: criterionId, criterion, status: "verified", command_kind: "human", decision_id: ticket.owner_decision_basis.decision_id };
    if (steps.length) return { criterion_id: criterionId, criterion, status: "not_applicable", command_kind: null, test_path: null };
    return { criterion_id: criterionId, criterion, status: "evidence_pending", command_kind: null, test_path: null };
  });
}

// Resolves legacy criterion text and stable IDs without accepting an unknown criterion.
function criterionIndex(entry, criteria) {
  if (typeof entry?.criterion_id === "string" && /^AC-[1-9][0-9]*$/.test(entry.criterion_id)) {
    const index = Number(entry.criterion_id.slice(3)) - 1;
    return index >= 0 && index < criteria.length ? index : -1;
  }
  if (Number.isInteger(entry?.criterion_index)) return entry.criterion_index >= 0 && entry.criterion_index < criteria.length ? entry.criterion_index : -1;
  return typeof entry?.criterion === "string" ? criteria.indexOf(entry.criterion) : -1;
}

// Connects only explicit command criteria to a passing command; leaves behavior for review.
function commandCoverage(criterion, index, commands) {
  const phrase = String(criterion ?? "").trim();
  const commandOnly = /^(?:the\s+)?(?:(?:ui|backend)\s+)?(schema validation|typecheck|type check|lint|build|compile)\s+(?:passes|succeeds|is green|must pass)\.?$/i.exec(phrase);
  const kind = commandOnly?.[1].toLowerCase().replace("type check", "typecheck").replace("compile", "build").replace("schema validation", "schema_validation");
  const passing = kind && commands.find((command) => command.kind === kind && command.exit_code === 0);
  return { criterion_id: `AC-${index + 1}`, criterion, status: passing ? "verified" : "evidence_pending", ...(passing ? { command_kind: kind } : {}) };
}
