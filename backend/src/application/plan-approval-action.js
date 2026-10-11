// Continues an exact owner-approved Architecture plan through the shared planning handoff without starting RUN.
import { ConfigurationError } from "../shared/errors.js";

// Rechecks current revision, source integrity and authenticated approver before admitting the Sprint Leader handoff.
export async function handoffApprovedRevision({ projectId, planId, revision, sha256, approverId, markdownPlanStore, planStore, sprintRegistry, handoffApprovedPlan }) {
  if (!Number.isSafeInteger(revision) || revision < 1 || !/^[a-f0-9]{64}$/.test(sha256 ?? "") || !approverId) throw fail("PLAN_APPROVAL_IDENTITY_REQUIRED", "Exact revision, checksum and authenticated owner are required.");
  const markdown = markdownPlanStore?.list?.().find((entry) => entry.plan_id === planId);
  const head = markdown ?? planStore?.list?.().find((entry) => entry.plan_id === planId);
  if (!head) throw fail("PLAN_NOT_FOUND", "Plan is not indexed for this project.");
  if (head.project_id !== projectId) throw fail("PROJECT_CONTEXT_CONFLICT", "Plan belongs to a different project.");
  if (head.revision !== revision || head.sha256 !== sha256) throw fail("PLAN_APPROVAL_STALE", "Reload and review the current plan before continuing handoff.");
  const identity = { planId, revision, sha256 };
  const plan = markdown ? await markdownPlanStore.assertApproved(identity) : await planStore.assertExecutable(identity);
  if (plan.project_id !== projectId) throw fail("PROJECT_CONTEXT_CONFLICT", "Approved artifact belongs to another project.");
  if (markdown && plan.decision?.approver_id !== approverId) throw fail("PLAN_APPROVAL_OWNER_MISMATCH", "Authenticated owner differs from the recorded approval.");
  if (typeof handoffApprovedPlan !== "function") throw fail("PLAN_HANDOFF_UNAVAILABLE", "Approved-plan handoff is unavailable.");
  const handoff = await handoffApprovedPlan({ projectId, plan, conversationId: plan.conversation_id ?? null });
  let sprintStatus;
  if (handoff.status === "handed_to_sprint_leader") {
    const scheduled = handoff.sprint_id && sprintRegistry?.get?.(handoff.sprint_id);
    if (!scheduled || !sprintRegistry?.setStatus) throw fail("SPRINT_REGISTRY_UNAVAILABLE", "Completed handoff requires an authoritative Registry binding.");
    sprintStatus = ["planned", "awaiting_human_approval"].includes(scheduled.status)
      ? (await sprintRegistry.setStatus({ sprintId: handoff.sprint_id, status: "ready", expectedVersion: scheduled.version })).status
      : scheduled.status;
  }
  return { plan_id: planId, revision, sha256, ...handoff, ...(sprintStatus ? { sprint_status: sprintStatus } : {}), run_started: false, coder_dispatched: false, supervisor_dispatched: false };
}

// Reports actionable approval conflicts without leaking credential or plan content.
function fail(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }
