// Provides completion reporting for governed agent ticket work.
import { ConfigurationError } from "../shared/errors.js";
import { completeNodeReportEvidence } from "./node-report-evidence.js";
import { assertCoderCoverage } from "../modules/supervisor/completion-report-service.js";
import { matchesBrowserEvidence } from "../modules/supervisor/browser-verification-evidence.js";
import { hasOwnerDecisionEvidence } from "../modules/governance/plan-decision-requests.js";
import { findPassingVerificationCommand } from "./verification-command-evidence.js";
import { readCompletedCoderReport } from "./completed-coder-report.js";
import { assertAgentExchangePayload } from "../modules/governance/agent-exchange.js";

const error = (code, message, details = {}) => Object.assign(new ConfigurationError(message), { code, details });

// Creates the governed completion-report tool.
export function createReportDoneTool({ reportService, verificationService, reviewFindings, onEvalCase } = {}) {
  if (!reportService?.buildFinalReport || !reportService?.saveReport || !reportService?.writeReportFile) throw new ConfigurationError("report_done requires the Supervisor completion report service.");
  if (onEvalCase !== undefined && typeof onEvalCase !== "function") throw new ConfigurationError("report_done onEvalCase must be a function.");
  return Object.freeze({ name: "report_done", async execute(input = {}, context = {}) {
    const ticket = context.ticket ?? context.task;
    if (!ticket?.id) throw error("SCOPE_INVALID", "Node must provide the current ticket for report_done.");
    if (input.status === "needs_context") {
      if (!input.summary?.trim()) throw error("INPUT_INVALID", "needs_context reports require a summary explaining the missing symbol or contract.");
      const report = await reportService.buildFinalReport({ ticket, status: "needs_human_review", verifyResult: null, filesChanged: context.changed_paths ?? [], reason: "coder_needs_context" });
      report.agent_report = { status: "needs_context", summary: input.summary.trim(), ...(input.evidence ? { evidence: input.evidence } : {}) };
      report.criteria_check = (ticket.acceptance_criteria ?? []).map((criterion) => ({ criterion, node_verified: null, status: "evidence_pending" }));
      await reportService.saveReport(ticket.id, report);
      await reportService.writeReportFile(ticket.id, report);
      throw error("CODER_NEEDS_CONTEXT", `NEEDS_CONTEXT: ${input.summary.trim()}`, { summary: input.summary.trim(), ...(input.evidence ? { evidence: input.evidence } : {}) });
    }
    if (input.status === "blocked") {
      const reasons = ["SCOPE_CONFLICT", "CONTRACT_DECISION_REQUIRED", "ACCESS_REQUIRED", "SECURITY_RISK", "ACCEPTANCE_AMBIGUOUS"];
      if (!input.summary?.trim() || !reasons.includes(input.blocker?.reason_code) || !input.evidence?.length || (!input.blocker.consultation && !input.blocker.owner_action?.trim())) throw error("INPUT_INVALID", "Blocked reports require a summary, blocker reason, consultation for SL, and source evidence.");
      const consultation = assertAgentExchangePayload("consultation_request", input.blocker.consultation ?? {
        question: input.summary.trim(), decision_needed: input.blocker.owner_action.trim(), known_decision_refs: [], impact: input.summary.trim() });
      const report = await reportService.buildFinalReport({ ticket, status: "needs_human_review", verifyResult: null, filesChanged: context.changed_paths ?? [], reason: "coder_blocked" });
      report.agent_report = { status: "blocked", summary: input.summary.trim(), blocker: input.blocker, evidence: input.evidence, ...(input.implementation_scope ? { implementation_scope: input.implementation_scope } : {}) };
      report.criteria_check = (ticket.acceptance_criteria ?? []).map((criterion) => ({ criterion, node_verified: null, status: "evidence_pending" }));
      await reportService.saveReport(ticket.id, report);
      await reportService.writeReportFile(ticket.id, report);
      throw error("CODER_BLOCKED", `${input.blocker.reason_code}: ${input.summary.trim()} SL decision: ${consultation.decision_needed}`, { summary: input.summary.trim(), blocker: input.blocker, consultation, evidence: input.evidence });
    }
    if (input.blocker !== undefined) throw error("INPUT_INVALID", "Blocker details require status blocked.");
    const governed = Boolean(verificationService && !context.lab_mode && !context.labMode);
    const requiresExplanation = Boolean(reviewFindings?.recordCoderReport);
    let artifact = null;
    if (governed) {
      artifact = await (verificationService.ensurePassedArtifact?.({ abortSignal: context.abortSignal, onWaiting: context.onVerificationWaiting, onSettled: context.onVerificationSettled }) ?? verificationService.assertPassedArtifact());
      context.abortSignal?.throwIfAborted();
      // Legacy review payloads are ignored; ticket completion is owned by the Coder report and Node verification.
      if (input.finding_resolutions !== undefined) delete input.finding_resolutions;
      context.changed_paths = [...(artifact.changed_paths ?? Object.keys(artifact.file_checksums))];
      const completed = requiresExplanation ? await readCompletedCoderReport({ reviewFindings, artifact, input }) : null;
      input = completed ?? completeNodeReportEvidence(input, ticket, artifact);
      if (requiresExplanation) {
        input = canonicalizeCoverageHints(input, ticket);
        input.acceptance_coverage = assertAcceptanceCoverage(input, artifact, ticket);
        if (!completed) input = await reviewFindings.recordCoderReportDraft({ report: input, artifact });
        const missing = missingExplanation(input);
        if (missing.length) throw error("CODER_EXPLANATION_REQUIRED", `Coder report saved. Supplement only these missing fields with report_done: ${missing.join(", ")}.`, { missing_fields: missing, artifact_id: artifact.artifact_id });
        assertExplanation(input, artifact);
        input.acceptance_criteria ??= [...(ticket.acceptance_criteria ?? [])];
        validateGovernedScope(input, artifact);
        assertCoderCoverage(input.acceptance_coverage);
        if (!completed) await reviewFindings.recordCoderReport({ report: input, artifact, idempotencyKey: `${artifact.artifact_id}:report` });
      }
      else {
        input.acceptance_coverage = assertAcceptanceCoverage(input, artifact, ticket);
        assertCoderCoverage(input.acceptance_coverage);
      }
      context.verify_result = { status: "passed", ready_for_review: true, artifact_id: artifact.artifact_id, commit_id: artifact.commit_sha };
    }
    if (typeof input.summary !== "string" || !input.summary.trim()) throw error("INPUT_INVALID", "Report summary is required.");
    if (!governed) assertReportScope(ticket, context);
    context.abortSignal?.throwIfAborted();
    const report = await reportService.buildFinalReport({ ticket, status: governed ? "submitted_for_review" : context.status ?? "completed", verifyResult: context.verify_result ?? null, filesChanged: context.changed_paths ?? [], reason: "agent_report_done" });
    if (!governed) assertReportVerified(report);
    if (governed) report.criteria_check = input.acceptance_coverage.map((entry) => ({ criterion: entry.criterion, criterion_id: entry.criterion_id, node_verified: entry.status === "verified", status: entry.status, command_kind: entry.command_kind ?? null, test_path: entry.test_path ?? null, artifact_id: artifact.artifact_id }));
    report.agent_report = { ...(report.agent_report ?? {}), ...input, summary: input.summary.trim() };
    context.abortSignal?.throwIfAborted();
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
      if (entry.command_kind === "human") {
        if (!ticket.verification_plan?.some((step) => step.kind === "human" && step.criterion_ids?.includes(`AC-${index + 1}`)) || !hasOwnerDecisionEvidence(ticket, `AC-${index + 1}`)) throw error("ACCEPTANCE_COVERAGE_MISSING", "Human evidence requires an exact owner-approved plan decision.");
        normalized.push({ ...entry, criterion_id: `AC-${index + 1}`, criterion, status });
        continue;
      }
      if (!entry.command_kind) throw error("ACCEPTANCE_COVERAGE_MISSING", `Verified criterion needs a command: ${criterion}`, { criterion_id: `AC-${index + 1}` });
      if (!/\b(build|lint|typecheck|type check|schema validation|compile|syntax)\b/i.test(criterion) && !["test", "backend_tests", "browser"].includes(entry.command_kind)) throw error("ACCEPTANCE_COVERAGE_MISSING", `Behavioral criterion requires a focused test: ${criterion}`, { criterion_id: `AC-${index + 1}` });
      const command = entry.command_kind === "browser"
        ? (artifact.commands ?? []).find((item) => item.kind === "browser" && item.exit_code === 0 && (!entry.test_path || item.argv?.includes(entry.test_path)))
        : findPassingVerificationCommand(entry, artifact.commands ?? []);
      if (!command || (["test", "backend_tests"].includes(entry.command_kind) && !entry.test_path)) throw error("ACCEPTANCE_COVERAGE_MISSING", `No passing command covers criterion: ${criterion}`, { criterion_id: `AC-${index + 1}` });
      if (entry.command_kind === "browser" && !ticket.verification_plan?.some((step) => step.kind === "browser" && step.criterion_ids?.includes(`AC-${index + 1}`) && matchesBrowserEvidence(step, command.browser_evidence))) throw error("ACCEPTANCE_COVERAGE_MISSING", `No approved browser receipt covers criterion: ${criterion}`, { criterion_id: `AC-${index + 1}` });
      entry.command_kind = command.kind;
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
