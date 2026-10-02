// Provides completion reporting for governed agent ticket work.
import { ConfigurationError } from "../shared/errors.js";

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
      artifact = await verificationService.assertPassedArtifact();
      if (input.finding_resolutions !== undefined) throw error("REVIEW_RESPONSE_REQUIRED", "Use respond_to_review for findings; a Coder report cannot decide their status.");
      context.changed_paths = [...(artifact.changed_paths ?? Object.keys(artifact.file_checksums))];
      if (requiresExplanation) {
        input = await reviewFindings.recordCoderReportDraft({ report: input, artifact });
        const missing = missingExplanation(input);
        if (missing.length) throw error("CODER_EXPLANATION_REQUIRED", `Coder report saved. Supplement only these missing fields with report_done: ${missing.join(", ")}.`, { missing_fields: missing, artifact_id: artifact.artifact_id });
        assertExplanation(input, artifact, ticket);
        validateGovernedScope(input, artifact);
        await reviewFindings.recordCoderReport({ report: input, artifact, idempotencyKey: `${artifact.artifact_id}:report` });
      }
      context.verify_result = { status: "passed", ready_for_review: true, artifact_id: artifact.artifact_id, commit_id: artifact.commit_sha };
    }
    if (typeof input.summary !== "string" || !input.summary.trim()) throw error("INPUT_INVALID", "Report summary is required.");
    if (!governed) assertReportScope(ticket, context, input.summary);
    const report = await reportService.buildFinalReport({ ticket, status: governed ? "submitted_for_review" : context.status ?? "completed", verifyResult: context.verify_result ?? null, filesChanged: context.changed_paths ?? [], reason: "agent_report_done" });
    if (!governed) assertReportVerified(report);
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

// Lists only the explanation fields that still need a supplement before review.
function missingExplanation(input) {
  return [
    ...(!Array.isArray(input.acceptance_criteria) || !input.acceptance_criteria.length ? ["acceptance_criteria"] : []),
    ...(!Array.isArray(input.implementation_scope?.changed_files) || !Array.isArray(input.implementation_scope?.not_changed_files) || !input.implementation_scope?.scope_rationale?.trim() ? ["implementation_scope"] : []),
    ...(!Array.isArray(input.evidence) || !input.evidence.length ? ["evidence"] : []),
    ...(!Array.isArray(input.reviewer_notes) ? ["reviewer_notes"] : [])
  ];
}

// Requires a concrete scope explanation before the first independent review.
function assertExplanation(input, artifact, ticket) {
  const scope = input.implementation_scope;
  if (!Array.isArray(input.acceptance_criteria) || !input.acceptance_criteria.length || !scope || !Array.isArray(scope.changed_files) || !Array.isArray(scope.not_changed_files) || !scope.scope_rationale?.trim() || !Array.isArray(input.evidence) || !input.evidence.length || !Array.isArray(input.reviewer_notes)) throw error("CODER_EXPLANATION_REQUIRED", "Coder must submit acceptance coverage, implementation scope, evidence and Reviewer notes.");
  if (input.acceptance_criteria.some((item) => !(ticket.acceptance_criteria ?? []).includes(item))) throw error("CODER_EXPLANATION_CRITERIA", "Acceptance coverage must cite the ticket criteria verbatim. The draft is saved; correct only acceptance_criteria without rewriting the summary.", { acceptance_criteria: ticket.acceptance_criteria ?? [] });
  if (input.evidence.some((item) => !item?.type?.trim() || !item.reference?.trim() || !item.result?.trim()) || input.reviewer_notes.some((item) => !item?.topic?.trim() || !item.position?.trim() || !item.rationale?.trim() || !Array.isArray(item.evidence_refs) || !item.evidence_refs.length || item.evidence_refs.some((ref) => !String(ref).trim()))) throw error("CODER_EXPLANATION_INVALID", "Coder evidence and Reviewer notes must include typed references, results and evidence references.");
  const changed = [...(artifact.changed_paths ?? Object.keys(artifact.file_checksums))].sort();
  if (JSON.stringify([...scope.changed_files].sort()) !== JSON.stringify(changed)) throw error("CODER_EXPLANATION_SCOPE", "Use the passed artifact changed_paths for implementation_scope.changed_files; correct only implementation_scope in the saved draft.", { expected_changed_files: changed, artifact_id: artifact.artifact_id });
}

// Validates actual commit scope without forcing the Coder to edit every allowed file.
function validateGovernedScope(input, artifact) {
  const scope = input.implementation_scope;
  const changed = [...(artifact.changed_paths ?? Object.keys(artifact.file_checksums))].sort();
  if (scope.not_changed_files.some((path) => changed.includes(path))) throw error("CODER_EXPLANATION_SCOPE", "A file cannot be listed as unchanged when it is in the committed delta.");
  if (new Set(scope.changed_files).size !== scope.changed_files.length || new Set(scope.not_changed_files).size !== scope.not_changed_files.length || scope.changed_files.some((path) => scope.not_changed_files.includes(path))) throw error("CODER_EXPLANATION_SCOPE", "Changed and unchanged file lists must be disjoint and duplicate-free.");
  if (scope.changed_files.some((path) => !Object.hasOwn(artifact.file_checksums, path)) || JSON.stringify([...scope.changed_files].sort()) !== JSON.stringify(changed)) throw error("CODER_EXPLANATION_SCOPE", "Use the passed artifact changed_paths for implementation_scope.changed_files; correct only implementation_scope in the saved draft.", { expected_changed_files: changed, artifact_id: artifact.artifact_id });
}

// Requires completion to cover the sprint leader PATCH files.
function assertReportScope(ticket, context, summary) {
  if (context.lab_mode || context.labMode) return;
  const changed = Array.isArray(context.changed_paths) ? context.changed_paths.filter((path) => typeof path === "string" && path) : [];
  if (changed.length === 1 && changed[0] === "backend/tool-lab-target.txt") throw error("REPORT_SCOPE_INVALID", "Tool-lab marker cannot complete a real ticket.");
  const patchFiles = patchCandidatePaths(ticket);
  const unskipped = patchFiles.filter((path) => !skipReason(summary, path));
  const missing = unskipped.filter((path) => !changed.includes(path));
  if (missing.length) throw error("REPORT_SCOPE_INVALID", `Ticket requires PATCH files ${missing.join(", ")} but they were not changed; edit each file or state in the summary why a file needs no change.`);
  const target = typeof context.target_path === "string" && context.target_path ? context.target_path : null;
  if (target && !changed.some((path) => path === target || path.startsWith(`${target.replace(/\/$/, "")}/`))) throw error("REPORT_SCOPE_INVALID", `Ticket target is ${target} but it was not changed; completion must touch the target file or a file inside the target directory.`);
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

// Collects sprint leader PATCH paths that completion must cover.
function patchCandidatePaths(ticket) {
  const candidates = Array.isArray(ticket?.candidate_files) ? ticket.candidate_files : [];
  return candidates.filter((entry) => entry?.role === "PATCH" && typeof entry?.path === "string" && entry.path).map((entry) => entry.path);
}

// Accepts a skipped PATCH file when the summary names it with a no-change reason.
function skipReason(summary, path) {
  if (typeof summary !== "string" || !summary.includes(path)) return false;
  return /no change|not needed|unnecessary|already (correct|handles|supports)|out of scope/i.test(summary);
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
  if (Array.isArray(ticket?.style) && ticket.style.length && !ticket.style.includes("frontend")) return false;
  return (ticket?.acceptance_criteria ?? []).some((criterion) => typeof criterion === "string" && /\b(ui|frontend|front-end|react|next(?:\.js)?|component|button|layout|watcher|header|screen|responsive|modal|dashboard)\b/i.test(criterion));
}

// Identifies UI implementation paths.
function isUiPath(path) { return path.startsWith("ui/nextjs/") || path.startsWith("ui/src/") || path.startsWith("web/src/"); }

// Identifies backend implementation or test paths.
function isBackendPath(path) { return path.startsWith("backend/src/") || path.startsWith("backend/tests/"); }

// Identifies backend production implementation paths.
function isBackendImplementationPath(path) { return path.startsWith("backend/src/"); }
