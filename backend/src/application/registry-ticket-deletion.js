// Removes tickets from current Registry scope without deleting immutable plans or execution history.

// Returns a scoped deletion failure instead of falling back to obsolete Roadmap data.
function fail(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode, retryable: false, scope: "scoped" });
}

// Revises the owning Sprint under version fencing and requires fresh approval for its reduced ticket scope.
export async function removeRegistryTicket({ projectId, ticketId, sprintRegistry: registry, planStore: plans }) {
  if (!plans?.getRevision || !plans?.createRevision) throw fail("SPRINT_REGISTRY_CONFIG", "Registry ticket deletion requires the immutable plan store.", 503);
  const owners = (await registry.listDetails()).filter((sprint) => sprint.project_id === projectId && sprint.ticket_ids?.includes(ticketId));
  if (!owners.length) throw fail("TICKET_NOT_FOUND", `Unknown ticket: ${ticketId}.`, 404);
  if (owners.length !== 1) throw fail("TICKET_PLAN_SCOPE", "Ticket belongs to more than one active Sprint; reconcile ownership before deletion.");
  const detail = owners[0];
  const sprint = registry.assertMutable(detail.id, detail.version);
  if (detail.ticket_ids.length === 1) throw fail("SPRINT_LAST_TICKET", "Cannot delete the last ticket in a sprint; delete the sprint instead.");
  const plan = await plans.getRevision({ planId: sprint.plan_id, revision: sprint.plan_revision });
  if (plan.project_id !== projectId || plan.sprint_id !== sprint.sprint_id || plan.sha256 !== sprint.plan_sha256 || plan.file_path !== sprint.plan_path) throw fail("SPRINT_PLAN_MISMATCH", "Ticket deletion basis differs from the Registry binding.");
  const otherSprints = await registry.listDetails();
  if (otherSprints.some((entry) => entry.tickets?.some((ticket) => ticket.id !== ticketId && ticket.dependencies?.includes(ticketId)))) throw fail("TICKET_DEPENDENCY_CONFLICT", "Another active ticket depends on this ticket; revise dependent scope before deletion.");
  const ticketSpecs = (plan.content.ticket_specs ?? []).filter((ticket) => ticket.id !== ticketId);
  const content = { ...plan.content, tickets: plan.content.tickets.filter((id) => id !== ticketId), ticket_specs: ticketSpecs,
    dependencies: [...new Set(ticketSpecs.flatMap((ticket) => ticket.dependencies ?? []))] };
  const revision = await plans.createRevision({ planId: sprint.plan_id, sprintId: sprint.sprint_id, expectedRevision: sprint.plan_revision, content });
  let updated;
  try { updated = await registry.bindPlan({ sprintId: sprint.sprint_id, planId: sprint.plan_id, revision: revision.revision, expectedVersion: sprint.version }); }
  catch (error) { error.recovery = { plan_id: sprint.plan_id, revision: revision.revision, sha256: revision.sha256, disposition: "retained_immutable_revision" }; throw error; }
  return { deleted: true, ticket_id: ticketId, sprint_id: sprint.sprint_id, plan_id: updated.plan_id, plan_revision: updated.plan_revision, plan_sha256: updated.plan_sha256, version: updated.version, status: updated.status };
}
