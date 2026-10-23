// Refreshes stale dependency execution references only at a parked, finding-driven review repair boundary.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { acquireTicketFileLock } from "./ticket-file-lock.js";
import { assertDependencyExpectations } from "./ticket-dependency-expectations.js";

// Creates a reusable repair preflight that records old/new dependency evidence before transactional rebinding.
export function createReviewDependencyReconciliation({ ticketStatusStore, sprintRegistry, resolveTicketWorkspace, fileService, projectLogger = () => {} }) {
  return async ({ projectId, ticket, current, checkpoint, dependencyExpectations, reviewCheckpoint }) => {
    const binding = current?.details?.review_reopen;
    const repair = binding?.repair_cycle_id ? checkpoint?.review_cycle_id === binding.repair_cycle_id
      : Boolean(binding) && reviewCheckpoint?.status === "completed" && reviewCheckpoint.verdict === "request_changes";
    if (!repair || isDeepStrictEqual(current.details.dependency_expectations, dependencyExpectations)) return current;
    const lock = await acquireTicketFileLock(fileService, `${statePath()}/automatic-review-locks/OWNER-${ticket.id}.lock`);
    try {
      if (current.project_id !== projectId || !["reviewing", "failed", "pending"].includes(current.status) || current.details.launch_claim) throw conflict("Dependency repair requires a parked execution without an active launch.");
      const workspace = await resolveTicketWorkspace(ticket.id);
      const context = await workspace.executionContexts.load(ticket.id);
      if (!context || context.project_id !== projectId || context.task_id !== ticket.id) throw conflict("Repair context does not belong to the selected project ticket.");
      if (binding.repair_cycle_id ? context.review_repair_cycle_id !== binding.repair_cycle_id
        : context?.state !== "terminal" || context.review_commit_sha !== binding.commit || context.verification_artifact_id !== binding.artifact_id
          || reviewCheckpoint.commit !== binding.commit || reviewCheckpoint.verification?.artifact_id !== binding.artifact_id) throw conflict("Review repair source no longer matches its retained checkpoint.");
      assertDependencyExpectations({ projectId, ticket, expectations: dependencyExpectations, sprintRegistry, ticketStatusStore });
      const previous = current.details.dependency_expectations;
      if (!Array.isArray(previous) || previous.length !== dependencyExpectations.length) throw conflict("Dependency scope changed since the reviewed execution.");
      const replacements = [];
      for (const before of previous) {
        const after = dependencyExpectations.find((entry) => entry.ticket_id === before.ticket_id);
        if (!after || !isDeepStrictEqual({ ...before, execution_id: after.execution_id }, after)) throw conflict("Dependency plan or scheduling version changed since review.");
        if (before.execution_id !== after.execution_id) replacements.push(await replacementEvidence(after));
      }
      const evidence = { project_id: projectId, ticket_id: ticket.id, execution_id: current.details.execution_id, status_version: current.version,
        review_job_id: binding.job_id, repair_cycle_id: binding.repair_cycle_id ?? null, previous, dependencies: dependencyExpectations, replacements };
      const content = JSON.stringify(evidence);
      const digest = createHash("sha256").update(content).digest("hex");
      const receipt = { path: `${statePath()}/review-dependency-reconciliation/${digest}.json`, sha256: `sha256:${digest}` };
      let stored = null;
      try { stored = await fileService.readFile({ path: receipt.path }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (stored !== null && stored !== content) throw conflict("Dependency reconciliation receipt conflicts with existing evidence.");
      if (stored === null) await fileService.atomicWrite({ path: receipt.path, content, replace: false });
      const updated = ticketStatusStore.reconcileReviewDependencies(ticket.id, { executionId: current.details.execution_id, basis: current.details.execution_basis,
        expectedVersion: current.version, previous, dependencies: dependencyExpectations, receipt, validate: () => {
          assertDependencyExpectations({ projectId, ticket, expectations: dependencyExpectations, sprintRegistry, ticketStatusStore });
          for (const proof of replacements) if (ticketStatusStore.get(proof.ticket_id)?.version !== proof.status_version) throw conflict("Replacement dependency changed after its evidence was checked.");
        } });
      projectLogger({ event_name: "review.dependencies_reconciled", level: "info", status: "success", message: "Review repair dependency completions reconciled without restarting Coder.",
        task_id: ticket.id, source: "review-dependency-reconciliation", payload: { replacements: replacements.length, receipt: receipt.path, execution_id: current.details.execution_id } });
      return updated;
    } finally { await lock.release(); }
  };

  // Requires terminal context and immutable passed verification/integration before adopting a replacement completion.
  async function replacementEvidence(expected) {
    const row = ticketStatusStore.get(expected.ticket_id);
    const workspace = await resolveTicketWorkspace(expected.ticket_id);
    const context = await workspace.executionContexts.load(expected.ticket_id);
    const files = workspace.fileService ?? fileService;
    if (context?.state !== "terminal" || context.project_id !== row.project_id || context.task_id !== expected.ticket_id
      || !context.manifest_sha || !context.source_revision || !/^[a-f0-9]{40,64}$/.test(context.base_sha ?? "")
      || !/^[a-f0-9]{40,64}$/.test(context.review_commit_sha ?? "") || !/^ARTIFACT-[A-Za-z0-9-]+$/.test(context.verification_artifact_id ?? "")) throw conflict("Replacement dependency has no completed verification context.");
    const integration = JSON.parse(await files.readFile({ path: `${statePath()}/ticket-integrations/${expected.ticket_id}.json` }));
    const artifact = JSON.parse(await files.readFile({ path: `${statePath()}/ticket-verification/${expected.ticket_id}/artifacts/${context.verification_artifact_id}.json` }));
    if (integration.status !== "completed" || integration.task_id !== expected.ticket_id || integration.commit !== context.review_commit_sha
      || integration.artifact_id !== context.verification_artifact_id || integration.manifest_sha !== context.manifest_sha || integration.source_revision !== context.source_revision
      || artifact.status !== "passed" || artifact.task_id !== expected.ticket_id || artifact.project_id !== row.project_id || artifact.artifact_id !== context.verification_artifact_id
      || artifact.commit_sha !== context.review_commit_sha || artifact.manifest_sha !== context.manifest_sha || artifact.source_revision !== context.source_revision
      || artifact.base_sha !== context.base_sha) throw conflict("Replacement dependency verification and integration evidence do not agree.");
    return { ticket_id: expected.ticket_id, execution_id: expected.execution_id, status_version: row.version, commit_sha: context.review_commit_sha,
      artifact_id: context.verification_artifact_id, manifest_sha: context.manifest_sha, source_revision: context.source_revision };
  }
}

// Keeps incomplete, active or incompatible dependency completions outside the automatic repair boundary.
function conflict(message) { return Object.assign(new Error(message), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 }); }
