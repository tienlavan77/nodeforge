// Persists Sprint Leader's JSON projection against the owner-approved Markdown source.
import { sprintPlanDraftContent } from "./sprint-plan-draft.js";
import { assertMarkdownSprintScope } from "./markdown-sprint-scope.js";

// Binds a generated Sprint Plan to its approved parent and registers its immutable revision.
export function createSprintPlanDraftPersistence({ projectId, planStore, markdownPlanStore, sprintRegistry }) {
  return async function draftPlan(sprint, trace = {}) {
    if (sprint.project_id !== projectId) throw Object.assign(new Error("Sprint Leader plan project differs from the active project."), { code: "PROJECT_CONTEXT_CONFLICT", statusCode: 409 });
    const previous = sprintRegistry?.get(sprint.id) ?? null;
    const parentMatch = trace.approvedParentPlanKey?.match(/^(.*)-R([1-9]\d*)-([a-f0-9]{64})$/);
    const approvedMarkdown = parentMatch ? await markdownPlanStore.assertApproved({ planId: parentMatch[1], revision: Number(parentMatch[2]), sha256: parentMatch[3] }) : null;
    if (trace.approvedParentPlanKey && !approvedMarkdown) throw Object.assign(new Error("Approved Markdown identity is invalid."), { code: "PLAN_HANDOFF_STALE", statusCode: 409 });
    if (approvedMarkdown) assertMarkdownSprintScope(approvedMarkdown.markdown, sprint);
    const planId = previous?.plan_id ?? `PLAN-${sprint.id}`;
    const head = planStore.list().find((item) => item.plan_id === planId);
    if (trace.approvedParentPlanKey && head) {
      const existing = await planStore.getRevision({ planId, revision: head.revision });
      if (existing.proposal_id !== trace.approvedParentPlanKey) throw Object.assign(new Error("Sprint draft belongs to a different approved plan revision."), { code: "PLAN_HANDOFF_CONFLICT", statusCode: 409 });
      if (approvedMarkdown) await planStore.approveDerived({ planId, revision: existing.revision, sha256: existing.sha256, markdownPlanId: approvedMarkdown.plan_id, markdownRevision: approvedMarkdown.revision, markdownSha256: approvedMarkdown.sha256 });
      await bindObservedDraft(existing);
      return approvedMarkdown ? planStore.getRevision({ planId, revision: existing.revision }) : existing;
    }
    const draft = await planStore.createRevision({ planId, sprintId: sprint.id, expectedRevision: head?.revision ?? 0, content: sprintPlanDraftContent(sprint), proposalId: trace.approvedParentPlanKey ?? null, sourcePath: approvedMarkdown?.file_path ?? null, sourceSha256: approvedMarkdown?.sha256 ?? null });
    if (approvedMarkdown) await planStore.approveDerived({ planId, revision: draft.revision, sha256: draft.sha256, markdownPlanId: approvedMarkdown.plan_id, markdownRevision: approvedMarkdown.revision, markdownSha256: approvedMarkdown.sha256 });
    await bindObservedDraft(draft);
    return approvedMarkdown ? planStore.getRevision({ planId, revision: draft.revision }) : draft;

    // Preserves the workflow's observed scheduling basis and retains immutable evidence on conflict.
    async function bindObservedDraft(revision) {
      if (!sprintRegistry) return;
      try {
        if (!previous) {
          const records = sprintRegistry.list({ includeArchived: true });
          const position = records.reduce((maximum, record) => Math.max(maximum, record.position), -1) + 1;
          await sprintRegistry.register({ sprintId: sprint.id, position, dependencies: sprint.dependencies ?? [], planId: revision.plan_id, revision: revision.revision, status: approvedMarkdown ? "planned" : undefined });
        } else if (previous.plan_id === revision.plan_id && previous.plan_revision === revision.revision && previous.plan_sha256 === revision.sha256 && previous.plan_path === revision.file_path) {
          if (sprintRegistry.get(sprint.id)?.version !== previous.version) throw Object.assign(new Error("Sprint changed while its existing draft was being recovered; reconcile before continuing."), { code: "SPRINT_REGISTRY_CONFLICT", statusCode: 409, retryable: false, scope: "scoped", identifiers: [sprint.id] });
        } else {
          await sprintRegistry.bindPlan({ sprintId: sprint.id, planId: revision.plan_id, revision: revision.revision, expectedVersion: previous.version });
        }
      } catch (error) {
        if (["SPRINT_REGISTRY_CONFLICT", "SPRINT_REGISTRY_EXISTS", "SPRINT_REPLAN_RUNNING"].includes(error.code)) {
          error.recovery = { disposition: "retained_immutable_revision", project_id: projectId, sprint_id: sprint.id, plan_id: revision.plan_id, revision: revision.revision, sha256: revision.sha256, observed_version: previous?.version ?? null, requires_reconciliation: true };
        }
        throw error;
      }
    }
  };
}
