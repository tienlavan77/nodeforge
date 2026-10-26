// Transfers approved Architecture owner policies into immutable Sprint scope without creating another approval questionnaire.
import { readArchitectureDecisions, decisionError } from "./architecture-owner-decisions.js";
import { reconstructPlanFromCanonicalSource, parseArchitecturePlanJSON } from "./architecture-plan-json.js";
import { conversationPlanSourcePath, readConversationPlanSource } from "./conversation-plan-source.js";

const verifiedSources = new WeakMap();

// Separates the confirmed policy input from the canonical plan source. Conversation
// plans retain both identities: approval covers the exact rendered Markdown while
// decisions keep the intake or earlier revision on which the owner confirmed them.
// Verification is attached only to the checked in-memory artifact, never to a
// caller-supplied flag or a rewrite of the already approved immutable revision.
export async function verifyArchitectureDecisionSource({ parent, canonicalBytes, fileService }) {
  const record = readArchitectureDecisions(parent.markdown);
  if (!record) return;
  const canonicalPath = /^PLAN-[A-Za-z0-9._-]+$/.test(parent.plan_id) ? conversationPlanSourcePath({ planId: parent.plan_id, revision: parent.revision }) : null;
  const sameSource = record.source_path === parent.source_path && record.source_sha256 === parent.source_sha256;
  if (parent.source_path !== canonicalPath) {
    if (!sameSource) throw decisionError("ARCHITECTURE_DECISIONS_INVALID", "Architecture decisions differ from the retained source of the approved plan.");
    return;
  }
  reconstructPlanFromCanonicalSource({ canonicalBytes, sourceSha256: parent.source_sha256, markdown: parent.markdown, planId: parent.plan_id, revision: parent.revision });
  if (!sameSource) {
    const root = canonicalPath.slice(0, canonicalPath.lastIndexOf("/") + 1);
    const intake = record.source_path === `${root}conversation-intake.json`;
    const earlierRevision = record.source_path.startsWith(root) ? /^plan-source-r([1-9][0-9]*)\.json$/.exec(record.source_path.slice(root.length)) : null;
    if (!intake && (!earlierRevision || Number(earlierRevision[1]) >= parent.revision)) throw decisionError("ARCHITECTURE_DECISIONS_INVALID", "Conversation decisions must retain an input from the same plan and an earlier revision.");
    const source = await readConversationPlanSource({ fileService, path: record.source_path, sha256: record.source_sha256 });
    if (intake) {
      let value;
      try { value = JSON.parse(source); }
      catch (error) { throw decisionError("ARCHITECTURE_DECISIONS_INVALID", `Conversation decision input is malformed: ${error.name}.`); }
      if (value?.schema_version !== 1 || value.project_id !== parent.project_id || value.conversation_id !== parent.conversation_id) throw decisionError("ARCHITECTURE_DECISIONS_INVALID", "Conversation decision input belongs to a different project or conversation.");
    } else parseArchitecturePlanJSON(source);
  }
  verifiedSources.set(parent, decisionSourceIdentity(parent));
}

// Invalidates verification if a caller changes any bound artifact or source identity.
function decisionSourceIdentity(parent) {
  return [parent.plan_id, parent.revision, parent.project_id, parent.conversation_id, parent.sha256, parent.markdown, parent.source_path, parent.source_sha256];
}

// Captures choices only from the exact authenticated parent artifact, never from Sprint Leader output.
export function sprintArchitectureDecisions(parent) {
  if (!parent) return null;
  const record = readArchitectureDecisions(parent.markdown);
  if (!record) return null;
  const proof = verifiedSources.get(parent);
  const verified = proof && decisionSourceIdentity(parent).every((value, index) => value === proof[index]);
  const sameSource = record.source_path === parent.source_path && record.source_sha256 === parent.source_sha256;
  if ((!sameSource && !verified) || parent.status !== "approved" || parent.decision?.decision !== "approved" || parent.decision.sha256 !== parent.sha256) throw decisionError("ARCHITECTURE_DECISIONS_INVALID", "Sprint policies require the exact approved Architecture source.");
  return { ...record, parent_plan_id: parent.plan_id, parent_revision: parent.revision, parent_sha256: parent.sha256, approval_decision_id: parent.decision.decision_id, approver_id: parent.decision.approver_id };
}

// Refuses new policy questionnaires or deferred owner prerequisites instead of silently waiving them.
export function assertNoSprintPolicyRequests(content, { enforce = false } = {}) {
  if (!content.architecture_decisions && !enforce) return;
  if ((content.decision_requests ?? []).length || (content.ticket_specs ?? []).some((ticket) => (ticket.verification_plan ?? []).some((step) => step.kind === "human"))) throw decisionError("ARCHITECTURE_REPLAN_REQUIRED", "Owner decisions belong in the Architecture plan. SL must consume them, not create new approval requests; unresolved authority needs Architecture replanning.");
}
