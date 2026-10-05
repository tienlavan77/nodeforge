// Derives ticket report facts from immutable Node verification evidence.

// Adds source, command, and scope facts without claiming unproven behavior passed.
export function completeNodeReportEvidence(input, ticket, artifact) {
  const changed = [...(artifact.changed_paths ?? Object.keys(artifact.file_checksums ?? {}))].sort();
  const unchanged = Object.keys(artifact.file_checksums ?? {}).filter((path) => !changed.includes(path)).sort();
  const criteria = ticket.acceptance_criteria ?? [];
  const coverage = completeCoverage(input.acceptance_coverage, criteria, artifact.commands ?? [], ticket?.verification_plan);
  const evidence = Array.isArray(input.evidence) && input.evidence.length ? input.evidence : [
    { type: "verification", reference: artifact.artifact_id, result: "passed" },
    ...(artifact.commands ?? []).map((command) => ({ type: "command", reference: command.output_sha256 ?? artifact.artifact_id, result: `${command.kind}: exit ${command.exit_code}` }))
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
function completeCoverage(supplied, criteria, commands, verificationPlan) {
  if (Array.isArray(verificationPlan) && verificationPlan.length) return coverageFromPlan(criteria, commands, verificationPlan);
  const entries = Array.isArray(supplied) ? [...supplied] : [];
  const covered = new Set(entries.map((entry) => criterionIndex(entry, criteria)).filter((index) => index >= 0));
  for (let index = 0; index < criteria.length; index += 1) {
    if (!covered.has(index)) entries.push(commandCoverage(criteria[index], index, commands));
  }
  return entries;
}

// Converts the approved criterion map into Node-owned coverage from actual command receipts.
function coverageFromPlan(criteria, commands, verificationPlan) {
  return criteria.map((criterion, index) => {
    const criterionId = `AC-${index + 1}`;
    const steps = verificationPlan.filter((step) => step.criterion_ids?.includes(criterionId));
    const passing = steps.find((step) => hasPassingCommand(step, commands));
    if (passing) return { criterion_id: criterionId, criterion, status: "verified", command_kind: passing.kind, ...(passing.test_path ? { test_path: passing.test_path } : {}) };
    if (steps.some((step) => step.kind === "governance")) return { criterion_id: criterionId, criterion, status: "not_applicable", command_kind: null, test_path: null };
    return { criterion_id: criterionId, criterion, status: "evidence_pending", command_kind: null, test_path: null };
  });
}

// Matches an approved command step to a successful receipt without trusting agent claims.
function hasPassingCommand(step, commands) {
  return commands.some((command) => command.kind === step.kind && command.exit_code === 0 && (!step.test_path || command.argv?.includes(step.test_path)));
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
