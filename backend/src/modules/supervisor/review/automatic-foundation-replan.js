// Creates and optionally dispatches a governed foundation-only successor without changing the blocked ticket contract.
import { createHash } from "node:crypto";

// Builds a deterministic foundation ticket that preserves the original scope's non-transport acceptance.
function foundationTicket(ticket, sprintId, sourceTicketId) {
  const id = `${sourceTicketId}-FOUNDATION`;
  return { ...structuredClone(ticket), id, sprint_id: sprintId, title: `${ticket.title ?? sourceTicketId} foundation`,
    objective: `Implement the in-process multi-project lifecycle foundation for ${sourceTicketId}; do not add or invent public transport.`,
    dependencies: [], acceptance_criteria: [
      "Provide the in-process root-to-project catalog with stable per-root identity and isolated per-project runtime services.",
      "Provide per-project index, watcher, embedding worker, activity stream and cleanup/restart semantics without resource leaks.",
      "Preserve single-project bootstrap and leave add/remove/list transport acceptance for the separately governed transport slice."
    ],
    verification_plan: (ticket.verification_plan ?? []).filter((step) => step.kind !== "human"),
    execution_policy: { ...(ticket.execution_policy ?? {}), requires_existing_contract: false, contract_evidence: [] },
    provenance: { source: "architecture_decision", source_id: `FOUNDATION-REPLAN-${sourceTicketId}`, created_at: new Date().toISOString() } };
}

// Creates a derived, approved foundation Sprint only once for a blocked transport ticket.
export function createAutomaticFoundationReplan({ plans, markdownPlans, sprintRegistry, ticketStatusStore, projectId, dispatch } = {}) {
  if (!plans?.createRevision || !plans?.approveDerived || !markdownPlans?.assertApproved || !sprintRegistry?.register || !sprintRegistry?.setStatus || !ticketStatusStore?.create) return null;
  return Object.freeze({ prepare });

  // Splits only implementation sequencing; the original ticket remains immutable and owner-gated for transport.
  async function prepare({ job, plan, architecture }) {
    const sourceTicket = job.request.ticket;
    const suffix = createHash("sha256").update(`${projectId}:${sourceTicket.id}:${architecture?.basis?.sha256 ?? ""}`).digest("hex").slice(0, 12);
    const sprintId = `${sourceTicket.sprint_id}-FOUNDATION-${suffix}`;
    const planId = `PLAN-${sprintId}`;
    const ticket = foundationTicket(sourceTicket, sprintId, sourceTicket.id);
    if (sprintRegistry.get?.(sprintId)) return { sprint_id: sprintId, plan_id: planId, ticket_id: ticket.id, status: "existing" };
    const content = { ...structuredClone(plan.content), objective: ticket.objective, outcome: "Foundation delivery is separated from the owner-gated transport contract.",
      in_scope: "In-process lifecycle foundation only; no public CLI or HTTP add/remove/list contract.",
      out_of_scope: `${plan.content.out_of_scope ?? ""}\nPublic lifecycle transport contract and thin-CLI integration remain owner-gated.`,
      approach: "Reuse approved per-root identity and isolate runtime services per project; verify cleanup and single-project compatibility.",
      components: ["project lifecycle foundation", "per-project runtime isolation"], tickets: [ticket.id], ticket_specs: [ticket],
      dependencies: [], acceptance_criteria: ticket.acceptance_criteria, decision_requests: [] };
    // Derivation is idempotent: a previously created plan revision is reused instead of conflicting on expectedRevision 0.
    let revision;
    try {
      revision = await plans.createRevision({ planId, sprintId, expectedRevision: 0, content,
        proposalId: plan.proposal_id, sourcePath: plan.source_path, sourceSha256: plan.source_sha256 });
    } catch (error) {
      if (error.code !== "PLAN_REVISION_CONFLICT") throw error;
      const head = await plans.getRevision?.({ planId, revision: 1 });
      if (!head || head.sprint_id !== sprintId) throw error;
      revision = { revision: head.revision, sha256: head.sha256 };
    }
    await plans.approveDerived({ planId, revision: revision.revision, sha256: revision.sha256, markdownPlanId: architecture.basis.plan_id,
      markdownRevision: architecture.basis.revision, markdownSha256: architecture.basis.sha256 });
    // Uses the highest occupied position (including archived sprints) + 1: archived rows keep UNIQUE positions reserved.
    const registered = sprintRegistry.list({ includeArchived: true }) ?? sprintRegistry.list();
    const position = Math.max(-1, ...registered.map((entry) => entry.position)) + 1;
    const record = await sprintRegistry.register({ sprintId, position, dependencies: [], planId, revision: revision.revision, status: "planned" });
    const ready = await sprintRegistry.setStatus({ sprintId, status: "ready", expectedVersion: record.version });
    const status = ticketStatusStore.create(ticket.id, { execution_basis: { sprint_id: sprintId, project_id: projectId, version: ready.version,
      plan_id: ready.plan_id, plan_revision: ready.plan_revision, plan_path: ready.plan_path, plan_sha256: ready.plan_sha256 }, reason: "automatic_foundation_replan" });
    const dispatched = dispatch ? await dispatch({ ticket, sprintBasis: ready, dependencyExpectations: [] }) : null;
    return { sprint_id: sprintId, plan_id: planId, ticket_id: ticket.id, status: dispatched?.status ?? status.status, dispatched: Boolean(dispatched), source_ticket_id: sourceTicket.id };
  }
}
