// Provides completion reporting for governed agent ticket work.
import { ConfigurationError } from "../shared/errors.js";
import { completeNodeReportEvidence } from "./node-report-evidence.js";

const error = (code, message, details = {}) => Object.assign(new ConfigurationError(message), { code, details });

// Creates the governed completion-report tool.
export function createReportDoneTool({ reportService, verificationService, reviewFindings, onEvalCase } = {}) {
  if (!reportService?.buildFinalReport || !reportService?.saveReport || !reportService?.writeReportFile) throw new ConfigurationError("report_done requires the Supervisor completion report service.");
  if (onEvalCase !== undefined && typeof onEvalCase !== "function") throw new ConfigurationError("report_done onEvalCase must be a function.");
  return Object.freeze({ name: "report_done", async execute(input = {}, context = {}) {
    const ticket = context.ticket ?? context.task;
    if (!ticket?.id) throw error("SCOPE_INVALID", "Node must provide the current ticket for report_done.");
    const governed = Boolean(verificationService && !context.lab_mode && !context.labMode);
    const requiresExplanation = Boolean(reviewFindings?.recordCoderReport);
    let artifact = null;
    if (governed) {
      artifact = await (verificationService.ensurePassedArtifact?.() ?? verificationService.assertPassedArtifact());
      // Legacy review payloads are ignored; ticket completion is owned by the Coder report and Node verification.
      if (input.finding_resolutions !== undefined) delete input.finding_resolutions;
      context.changed_paths = [...(artifact.changed_paths ?? Object.keys(artifact.file_checksums))];
      input = completeNodeReportEvidence(input, ticket, artifact);
      if (requiresExplanation) {
        input = canonicalizeCoverageHints(input, ticket);
        input.acceptance_coverage = assertAcceptanceCoverage(input, artifact, ticket);
        input = await reviewFindings.recordCoderReportDraft({ report: input, artifact });
        const missing = missingExplanation(input);
        if (missing.length) throw error("CODER_EXPLANATION_REQUIRED", `Coder report saved. Supplement only these missing fields with report_done: ${missing.join(", ")}.`, { missing_fields: missing, artifact_id: artifact.artifact_id });
        assertExplanation(input, artifact);
        input.acceptance_criteria ??= [...(ticket.acceptance_criteria ?? [])];
        validateGovernedScope(input, artifact);
        await reviewFindings.recordCoderReport({ report: input, artifact, idempotencyKey: `${artifact.artifact_id}:report` });
      }
      else input.acceptance_coverage = assertAcceptanceCoverage(input, artifact, ticket);
      context.verify_result = { status: "passed", ready_for_review: true, artifact_id: artifact.artifact_id, commit_id: artifact.commit_sha };
    }
    if (typeof input.summary !== "string" || !input.summary.trim()) throw error("INPUT_INVALID", "Report summary is required.");
    if (!governed) assertReportScope(ticket, context);
    const report = await reportService.buildFinalReport({ ticket, status: governed ? "submitted_for_review" : context.status ?? "completed", verifyResult: context.verify_result ?? null, filesChanged: context.changed_paths ?? [], reason: "agent_report_done" });
    if (!governed) assertReportVerified(report);
    if (governed) report.criteria_check = input.acceptance_coverage.map((entry) => ({ criterion: entry.criterion, criterion_id: entry.criterion_id, node_verified: entry.status === "verified", status: entry.status, command_kind: entry.command_kind ?? null, test_path: entry.test_path ?? null, artifact_id: artifact.artifact_id }));
    report.agent_report = { ...(report.agent_report ?? {}), ...input, summary: input.summary.trim() };
    await reportService.saveReport(ticket.id, report); await reportService.writeReportFile(ticket.id, report);
    if (!governed && typeof onEvalCase === "function") {
      try {
        await onEvalCase({ ticket, report });
      } catch (error) {
        console.log(`[eval-append] skip ${ticket.id}: ${error?.message ?? error}`);
      }
    }
    return { content: [{ type: "text", text: "Completion report recorded." }] };
  }});
}

// Canonicalizes legacy coverage text before durable draft merging so retries remain idempotent.
function canonicalizeCoverageHints(input, ticket) {
  if (!Array.isArray(input?.acceptance_coverage)) return input;
  const criteria = ticket.acceptance_criteria ?? [];
  return {
    ...input,
    acceptance_coverage: input.acceptance_coverage.map((entry) => {
      const index = resolveCriterionIndex(entry, criteria);
      if (index < 0) return entry;
      return { ...entry, criterion_id: `AC-${index + 1}`, criterion: criteria[index], status: entry.status ?? "verified" };
    })
  };
}

// Lists only the explanation fields that still need a supplement before review.
function missingExplanation(input) {
  return [
    ...(!Array.isArray(input.acceptance_coverage) || !input.acceptance_coverage.length ? ["acceptance_coverage"] : []),
    ...(!Array.isArray(input.implementation_scope?.changed_files) || !Array.isArray(input.implementation_scope?.not_changed_files) || !input.implementation_scope?.scope_rationale?.trim() ? ["implementation_scope"] : []),
    ...(!Array.isArray(input.evidence) || !input.evidence.length ? ["evidence"] : []),
    ...[]
  ];
}

// Requires a concrete scope explanation before the first independent review.
function assertExplanation(input, artifact) {
  const scope = input.implementation_scope;
  if (!scope || !Array.isArray(scope.changed_files) || !Array.isArray(scope.not_changed_files) || !scope.scope_rationale?.trim() || !Array.isArray(input.evidence) || !input.evidence.length) throw error("CODER_EXPLANATION_REQUIRED", "Coder must submit acceptance coverage, implementation scope and typed evidence.");
  if (input.evidence.some((item) => !item?.type?.trim() || !item.reference?.trim() || !item.result?.trim())) throw error("CODER_EXPLANATION_INVALID", "Coder evidence must include typed references and results.");
  const changed = [...(artifact.changed_paths ?? Object.keys(artifact.file_checksums))].sort();
  if (JSON.stringify([...scope.changed_files].sort()) !== JSON.stringify(changed)) throw error("CODER_EXPLANATION_SCOPE", "Use the passed artifact changed_paths for implementation_scope.changed_files; correct only implementation_scope in the saved draft.", { expected_changed_files: changed, artifact_id: artifact.artifact_id });
}

// Binds every acceptance criterion to a successful command from the immutable artifact.
function assertAcceptanceCoverage(input, artifact, ticket) {
  const criteria = ticket.acceptance_criteria ?? [];
  const coverage = input.acceptance_coverage;
  if (!Array.isArray(coverage) || coverage.length !== criteria.length) throw error("ACCEPTANCE_COVERAGE_MISSING", "Provide one acceptance coverage entry per criterion.", { acceptance_criteria: criteria });
  const normalized = [];
  const used = new Set();
  for (const entry of coverage) {
    const index = resolveCriterionIndex(entry, criteria);
    if (index < 0 || used.has(index)) throw error("ACCEPTANCE_COVERAGE_MISSING", "Each acceptance criterion needs one unique criterion_id or criterion_index.", { acceptance_criteria: criteria });
    used.add(index);
    const status = entry.status ?? "verified";
    const criterion = criteria[index];
    if (status === "verified") {
      if (!entry.command_kind) throw error("ACCEPTANCE_COVERAGE_MISSING", `Verified criterion needs a command: ${criterion}`, { criterion_id: `AC-${index + 1}` });
      if (!/\b(build|lint|typecheck|type check|schema validation|compile|syntax)\b/i.test(criterion) && !["test", "backend_tests"].includes(entry.command_kind)) throw error("ACCEPTANCE_COVERAGE_MISSING", `Behavioral criterion requires a focused test: ${criterion}`, { criterion_id: `AC-${index + 1}` });
      const command = (artifact.commands ?? []).find((item) => item.kind === entry.command_kind && item.exit_code === 0 && (!entry.test_path || item.argv?.includes(entry.test_path)));
      if (!command || (["test", "backend_tests"].includes(entry.command_kind) && !entry.test_path)) throw error("ACCEPTANCE_COVERAGE_MISSING", `No passing command covers criterion: ${criterion}`, { criterion_id: `AC-${index + 1}` });
    }
    normalized.push({ ...entry, criterion_id: `AC-${index + 1}`, criterion, status, ...(status !== "verified" ? { command_kind: entry.command_kind ?? null, test_path: entry.test_path ?? null } : {}) });
  }
  if (used.size !== criteria.length) throw error("ACCEPTANCE_COVERAGE_MISSING", "Every acceptance criterion needs a coverage entry.", { acceptance_criteria: criteria });
  return normalized.sort((left, right) => Number(left.criterion_id.slice(3)) - Number(right.criterion_id.slice(3)));
}

// Resolves stable criterion IDs or indexes while accepting the legacy exact-text format.
function resolveCriterionIndex(entry, criteria) {
  if (typeof entry?.criterion_id === "string" && /^AC-[1-9][0-9]*$/.test(entry.criterion_id)) {
    const index = Number(entry.criterion_id.slice(3)) - 1;
    return index >= 0 && index < criteria.length ? index : -1;
  }
  if (Number.isInteger(entry?.criterion_index)) return entry.criterion_index >= 0 && entry.criterion_index < criteria.length ? entry.criterion_index : -1;
  if (typeof entry?.criterion === "string") return criteria.findIndex((criterion) => criterion === entry.criterion);
  return -1;
}

// Validates actual commit scope without forcing the Coder to edit every allowed file.
function validateGovernedScope(input, artifact) {
  const scope = input.implementation_scope;
  const changed = [...(artifact.changed_paths ?? Object.keys(artifact.file_checksums))].sort();
  if (scope.not_changed_files.some((path) => changed.includes(path))) throw error("CODER_EXPLANATION_SCOPE", "A file cannot be listed as unchanged when it is in the committed delta.");
  if (new Set(scope.changed_files).size !== scope.changed_files.length || new Set(scope.not_changed_files).size !== scope.not_changed_files.length || scope.changed_files.some((path) => scope.not_changed_files.includes(path))) throw error("CODER_EXPLANATION_SCOPE", "Changed and unchanged file lists must be disjoint and duplicate-free.");
  if (scope.changed_files.some((path) => !Object.hasOwn(artifact.file_checksums, path)) || JSON.stringify([...scope.changed_files].sort()) !== JSON.stringify(changed)) throw error("CODER_EXPLANATION_SCOPE", "Use the passed artifact changed_paths for implementation_scope.changed_files; correct only implementation_scope in the saved draft.", { expected_changed_files: changed, artifact_id: artifact.artifact_id });
}

// Requires changed implementation files without treating discovery hints as edit obligations.
function assertReportScope(ticket, context) {
  if (context.lab_mode || context.labMode) return;
  const changed = Array.isArray(context.changed_paths) ? context.changed_paths.filter((path) => typeof path === "string" && path) : [];
  if (changed.length === 1 && changed[0] === "backend/tool-lab-target.txt") throw error("REPORT_SCOPE_INVALID", "Tool-lab marker cannot complete a real ticket.");
  if (!changed.length) throw error("REPORT_SCOPE_INVALID", "Completion requires a committed ticket change.");
  if (hasUiCriteria(ticket) && !changed.some(isUiPath)) throw error("REPORT_SCOPE_INVALID", "UI ticket cannot be completed without changing a UI file.");
  if (isUiTicket(ticket) && hasBackendCriteria(ticket) && !changed.some(isBackendPath)) throw error("REPORT_SCOPE_INVALID", "Ticket has explicit backend acceptance criteria but no backend file was changed; UI-only work cannot complete it.");
  if (hasBackendCriteria(ticket) && changed.some(isBackendPath) && !changed.some(isBackendImplementationPath)) throw error("REPORT_SCOPE_INVALID", "Backend acceptance criteria require a backend implementation file, not only a backend test or metadata file.");
}

// Blocks completion when verifiable criteria have no Node verification.
function assertReportVerified(report) {
  if (report?.status !== "completed") return;
  const checks = Array.isArray(report.criteria_check) ? report.criteria_check : [];
  const verifiable = checks.filter((item) => /syntax|build|compile|test|lint/i.test(item?.criterion ?? ""));
  if (verifiable.length && verifiable.every((item) => item?.node_verified === null)) throw error("REPORT_UNVERIFIED", "Node did not verify any build/test acceptance criteria; completion report is blocked.");
}

// Identifies tickets whose scope requires UI implementation.
function isUiTicket(ticket) {
  const text = [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])].filter((value) => typeof value === "string").join(" ");
  return /\b(ui|frontend|front-end|react|next(?:\.js)?|component|page|button|layout|watcher|header|screen|responsive|status(?: area| line)?|dashboard|modal)\b/i.test(text);
}

// Detects explicit backend implementation requirements on a ticket.
function hasBackendCriteria(ticket) {
  return (ticket?.acceptance_criteria ?? []).some((criterion) => {
    if (typeof criterion !== "string") return false;
    if (/\b(backend|back-end|server|endpoint|api|database|db|sqlite|sprint leader|request payload)\b/i.test(criterion)) return true;
    return /\b(persist|persistence)\b/i.test(criterion) && /\b(database|db|sqlite|server|backend|back-end)\b/i.test(criterion);
  });
}

// Detects UI-specific acceptance criteria.
function hasUiCriteria(ticket) {
  const implementationType = ticket?.implementation_type ?? ticket?.style;
  if (Array.isArray(implementationType) && implementationType.length && !implementationType.includes("frontend")) return false;
  return (ticket?.acceptance_criteria ?? []).some((criterion) => typeof criterion === "string" && /\b(ui|frontend|front-end|react|next(?:\.js)?|component|button|layout|watcher|header|screen|responsive|modal|dashboard)\b/i.test(criterion));
}

// Identifies UI implementation paths.
function isUiPath(path) { return path.startsWith("ui/nextjs/") || path.startsWith("ui/src/") || path.startsWith("web/src/"); }

// Identifies backend implementation or test paths.
function isBackendPath(path) { return path.startsWith("backend/src/") || path.startsWith("backend/tests/"); }

// Identifies backend production implementation paths.
function isBackendImplementationPath(path) { return path.startsWith("backend/src/"); }
