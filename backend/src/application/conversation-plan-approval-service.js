// Dedicated owner approval routing for conversation-originated Architecture Plans (O3/O4).
// Business purpose: this module owns the security-critical handoff step that the create/update
// tickets intentionally left untouched. It approves ONLY the latest pending RENDERED revision of
// the CURRENT conversation, announces that revision's identity before recording anything, captures
// the revision and SHA-256 the owner actually saw, rechecks them, then stores an idempotent owner
// decision with the authenticated owner and passes the unchanged Markdown plan gate (assertApproved)
// before admitting the Sprint Leader handoff. It never starts a RUN. Approved sections 3.2.2-3.2.6
// and 6 are the mandatory authority. A mixed create/update-plus-approve message never approves,
// quoted, fenced and interrogative approval text has no approval side effect, and a cross-conversation
// or superseded target cannot authorize a different revision. Existing API authentication, superseded
// protection and the SUMMARY snapshot gate stay exactly as the accepted create/update and Markdown
// store behavior delivered them.
// Technical description: it reads the real conversation-bound Markdown plan store, decides through
// its append-only decide(), authorizes through its assertApproved(), and hands off only via the
// injected handoff function. The decision identity is deterministic from plan_id/revision/sha256 so a
// duplicate approval delivery reuses one decision; a revision whose handoff already completed reuses
// the Sprint Leader result without re-invoking handoff. All authority checks are fail-closed: any
// unmet identity, owner, freshness, conversation-scope or mixed-intent condition aborts with a
// governance error code before any decision write or handoff.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { detectPlanApproveTrigger, detectPlanCreateTrigger, detectPlanUpdateTrigger } from "../modules/governance/conversation-plan-trigger.js";

// Plan statuses Node may act on: a fresh render awaiting the owner's first approval, or an already
// approved revision so a duplicate delivery replays one decision and one handoff instead of opening a
// second approval window. A rejection or a revision change closes approval until a newer render exists.
const SELECTABLE_STATUSES = new Set(["awaiting_human_approval", "approved"]);

// Creates one conversation approval router bound to a single project's plan store and handoff.
export function createConversationPlanApprovalService({ projectId, markdownPlanStore, handoffApprovedPlan, sprintRegistry } = {}) {
  if (!projectId || !markdownPlanStore?.list || !markdownPlanStore?.getRevision || !markdownPlanStore?.decide || !markdownPlanStore?.assertApproved) {
    throw fail("CONVERSATION_PLAN_APPROVAL_UNAVAILABLE", "Conversation approval needs the project Markdown plan store.");
  }
  return Object.freeze({ selectPendingRevision, approveFromConversation });

  // Selects the latest pending rendered revision bound to one conversation, announcing its identity.
  async function selectPendingRevision({ conversationId } = {}) {
    if (!conversationId) throw fail("PLAN_APPROVAL_CONVERSATION_REQUIRED", "Conversation approval needs the active conversation identity.");
    const heads = markdownPlanStore.list().filter((entry) => entry.conversation_id === conversationId && entry.project_id === projectId);
    let latest = null;
    for (const head of heads) {
      const revision = await markdownPlanStore.getRevision({ planId: head.plan_id, revision: head.revision });
      if (!SELECTABLE_STATUSES.has(revision.status)) continue;
      if (!latest || String(revision.created_at ?? "") >= String(latest.created_at ?? "")) latest = revision;
    }
    if (!latest) throw fail("PLAN_APPROVAL_PENDING_MISSING", "There is no pending rendered plan revision in this conversation to approve.");
    return { plan_id: latest.plan_id, revision: latest.revision, sha256: latest.sha256, conversation_id: latest.conversation_id, markdown: latest.markdown, created_at: latest.created_at, decision: latest.decision ?? null, handoff_status: latest.handoff_status ?? null, sprint_id: latest.sprint_id ?? null };
  }

  // Records one owner decision for the conversation's latest pending revision, then hands it off.
  async function approveFromConversation({ conversationId, approvedOwnerId, approvalRevision, approvalSha256, approvalComments = null, text } = {}) {
    if (!approvedOwnerId) throw fail("PLAN_OWNER_UNAUTHORIZED", "Authenticated owner identity is required to approve a plan.");
    assertPureApprovalIntent(text);
    const pending = await selectPendingRevision({ conversationId });
    if (approvalRevision !== undefined || approvalSha256 !== undefined) {
      if (approvalRevision !== pending.revision || approvalSha256 !== pending.sha256) throw fail("PLAN_APPROVAL_STALE", "The captured revision/checksum no longer matches the latest rendered plan.");
    }
    const announcement = announceRevision(pending);
    if (pending.decision) {
      if (pending.decision.approver_id !== approvedOwnerId) throw fail("PLAN_APPROVAL_OWNER_MISMATCH", "The authenticated owner differs from the recorded approval.");
      if (pending.decision.sha256 !== pending.sha256) throw fail("PLAN_APPROVAL_STALE", "The recorded decision does not match the current rendered checksum.");
    } else {
      await markdownPlanStore.decide({ planId: pending.plan_id, revision: pending.revision, sha256: pending.sha256, decision: "approved", approverId: approvedOwnerId, comments: approvalComments, decisionId: decisionIdentity(pending) });
    }
    const authorized = await markdownPlanStore.assertApproved({ planId: pending.plan_id, revision: pending.revision, sha256: pending.sha256 });
    if (authorized.decision?.approver_id !== approvedOwnerId) throw fail("PLAN_APPROVAL_OWNER_MISMATCH", "The authenticated owner must match the approved decision before handoff.");
    if (typeof handoffApprovedPlan !== "function") throw fail("PLAN_HANDOFF_UNAVAILABLE", "Approved-plan handoff is unavailable.");
    const handoff = pending.handoff_status === "completed" ? { status: "handed_to_sprint_leader", sprint_id: pending.sprint_id, plan_handoff: true, replayed: true } : await handoffApprovedPlan({ projectId, plan: authorized, conversationId });
    const sprintStatus = await resolveSprintStatus(handoff);
    return { command: "/approve", status: "handed_to_node", plan_id: pending.plan_id, revision: pending.revision, sha256: pending.sha256, conversation_id: pending.conversation_id, announcement, ...handoff, ...(sprintStatus ? { sprint_status: sprintStatus } : {}), replayed: handoff.replayed === true, run_started: false, coder_dispatched: false, supervisor_dispatched: false, text: announcement };
  }

  // Marks a ready Sprint for a completed handoff only while the registry permits it.
  async function resolveSprintStatus(handoff) {
    if (handoff.status !== "handed_to_sprint_leader" || handoff.replayed === true || !sprintRegistry?.get || !sprintRegistry?.setStatus) return undefined;
    if (!handoff.sprint_id) throw fail("SPRINT_REGISTRY_UNAVAILABLE", "Approved Sprint cannot be marked ready without its registry record.");
    const scheduled = sprintRegistry.get(handoff.sprint_id);
    if (!scheduled) throw fail("SPRINT_NOT_FOUND", "Sprint Leader handoff completed without a registered Sprint.");
    if (!["planned", "awaiting_human_approval"].includes(scheduled.status)) return scheduled.status;
    return (await sprintRegistry.setStatus({ sprintId: handoff.sprint_id, status: "ready" })).status;
  }
}

// Refuses any approval intent that mixes mutation with approval or is not a standalone imperative line.
function assertPureApprovalIntent(text) {
  if (text === undefined) return;
  const value = String(text ?? "");
  const mutation = detectPlanCreateTrigger(value) ?? detectPlanUpdateTrigger(value) ?? (/^\/plan\b/im.test(value) ? "/plan" : null);
  if (mutation) throw fail("PLAN_APPROVAL_MIXED", `A message mixing "${mutation}" with approval never approves; perform the create/update first, then send /approve or a standalone approve line as a separate message.`);
  if (detectPlanApproveTrigger(value) === null && !/^\/approve\s+\S+\s*$/i.test(value.trim())) throw fail("PLAN_APPROVAL_TRIGGER_REQUIRED", "Approval needs a standalone imperative approve line; quoted, fenced and interrogative text has no approval effect.");
}

// Builds a deterministic decision identity so one approved revision cannot gain duplicate decisions.
function decisionIdentity(pending) {
  const digest = createHash("sha256").update(`${pending.plan_id}|${pending.revision}|${pending.sha256}`).digest("hex").slice(0, 36);
  return `CONV-APPROVE-${digest}`;
}

// Announces the exact rendered revision Node is about to approve, so approval is never blind.
function announceRevision(pending) {
  return `Node sẽ duyệt plan ${pending.plan_id} revision ${pending.revision} (SHA-256 ${pending.sha256}) của cuộc hội thoại ${pending.conversation_id}. Đây là bản render mới nhất đang chờ; approve sẽ không bắt đầu RUN.`;
}

// Reports actionable approval conflicts without leaking credential or plan content.
function fail(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }
