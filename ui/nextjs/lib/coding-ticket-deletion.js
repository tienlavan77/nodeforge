// Applies confirmed ticket deletions to Coding scope while retaining unrelated Sprint cards and newer revisions.

// Filters deleted tickets and applies the server's replacement Sprint basis without refetching the dashboard.
export function applyCodingTicketDeletions(dashboard, deletions) {
  if (!dashboard?.roadmap?.sprints || !deletions.size) return dashboard;
  const sprints = dashboard.roadmap.sprints.map((sprint) => {
    const records = [...deletions.entries()].filter(([ticketId, receipt]) => {
      const ownsTicket = receipt.sprint_id ? receipt.sprint_id === sprint.id : sprint.tasks?.some((ticket) => ticket.id === ticketId);
      if (!ownsTicket) return false;
      if (receipt.plan_id && sprint.plan_id && receipt.plan_id !== sprint.plan_id) return false;
      if (Number.isSafeInteger(receipt.version) && Number.isSafeInteger(sprint.version) && sprint.version > receipt.version) return false;
      return !Number.isSafeInteger(receipt.plan_revision) || !Number.isSafeInteger(sprint.plan_revision) || sprint.plan_revision <= receipt.plan_revision;
    });
    if (!records.length) return sprint;
    const ids = new Set(records.map(([id]) => id));
    const receipt = records.map(([, item]) => item).sort((a, b) => (b.version ?? -1) - (a.version ?? -1))[0];
    const canPatch = Number.isSafeInteger(receipt.version) && receipt.version >= (sprint.version ?? -1);
    const revisionChanged = canPatch && receipt.plan_revision !== undefined && receipt.plan_revision !== sprint.plan_revision;
    const patch = canPatch ? Object.fromEntries(["version", "status", "plan_id", "plan_revision", "plan_sha256"].filter((key) => receipt[key] !== undefined).map((key) => [key, receipt[key]])) : {};
    return { ...sprint, ...patch, ticket_ids: sprint.ticket_ids?.filter((id) => !ids.has(id)),
      tasks: (sprint.tasks ?? []).filter((ticket) => !ids.has(ticket.id)).map((ticket) => revisionChanged ? { ...ticket, status: "untracked", progress: 0 } : ticket) };
  });
  return { ...dashboard, roadmap: { ...dashboard.roadmap, sprints } };
}
