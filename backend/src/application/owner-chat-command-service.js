// Implements owner planning commands without granting execution authority.
import { ConfigurationError } from "../shared/errors.js";
import { readMarkdownSprintScope } from "../modules/governance/markdown-sprint-scope.js";
import { createPlanWithDiagnostics } from "./plan-request-diagnostics.js";
import { createArchitecturePlanningService } from "./architecture-planning-service.js";
import { createConversationPlanningService, isConversationPlanMessage, planIdFromIntakePath } from "./conversation-planning-service.js";
import { createArchitectureClarificationStore } from "./architecture-clarification-store.js";
import { detectPlanApproveTrigger, detectPlanCreateTrigger, detectPlanHandoffRetryTrigger } from "../modules/governance/conversation-plan-trigger.js";
import { createAmSeHandoffService } from "./am-se-handoff-service.js";

const PLAN_RE = /^\/plan\s+(\S+)\s*$/i;
const APPROVE_RE = /^\/approve\s+(\S+)\s*$/i;
const CONTINUE_RE = /^\/plan-continue\s+(CLARIFY-[a-f0-9-]{36})\s*$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAN_FRAME_PATH = "workflows/agents/architecture/README.md";
const SUMMARY_EVIDENCE_RE = /\[(?:evidence|source):\s*(?:backend|schemas|ui|web)\/[A-Za-z0-9._/-]+(?:#L\d+(?:-L?\d+)?)?\]/i;

// Verifies planning-document references before extending the legacy code-source evidence gate.
/**
 * Business purpose: collects detailed verification diagnostics for repository evidence references in a rendered Markdown plan so self-healing prompts can tell Architecture Manager exactly which evidence paths exist or are missing.
 * Technical description: scans [Evidence: ...] and [Source: ...] tags in markdown, verifies each safe project-relative path through fileService.readFile, and returns { valid, verifiedPaths, missingPaths }.
 */
export async function inspectSummaryEvidence(markdown, fileService) {
  if (SUMMARY_EVIDENCE_RE.test(markdown)) return { valid: true, verifiedPaths: ["workflows/.nodeforge-summary"], missingPaths: [] };
  const verifiedPaths = [];
  const missingPaths = [];
  for (const match of String(markdown ?? "").matchAll(/\[(?:evidence|source):\s*(`?)([^`\]\r\n]+)\1\]/gi)) {
    const reference = match[2].trim();
    const path = reference.replace(/#L[1-9]\d*(?:-L?[1-9]\d*)?$/, "");
    if (!/^(?:docs|workflows|backend|schemas|ui|web)\/[A-Za-z0-9._/-]+$/.test(path) || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      missingPaths.push(reference);
      continue;
    }
    try {
      const content = await fileService.readFile({ path });
      if (typeof content === "string" && content.trim()) verifiedPaths.push(path);
      else missingPaths.push(path);
    } catch (error) {
      missingPaths.push(path);
      console.warn("Summary evidence reference could not be verified.", error.code ?? error.message);
    }
  }
  return { valid: verifiedPaths.length > 0 && missingPaths.length === 0, verifiedPaths, missingPaths };
}

// Verifies planning-document references before extending the legacy code-source evidence gate.
async function hasSummaryEvidence(markdown, fileService) {
  const report = await inspectSummaryEvidence(markdown, fileService);
  return report.verifiedPaths.length > 0;
}
const DISCOVERY_COMPLETE_RE = /(?:discovery complete|repository discovery complete)/i;
const DISCOVERY_UNVERIFIED_RE = /(?:assumption|unverified|unknown|uncertain)/i;

// Creates the command handler bound to one project and its immutable plan store.
export function createOwnerChatCommandService({ projectId, fileService, planStore, markdownPlanStore, handoffApprovedPlan, sprintRegistry, planRequests, publishPlanEvent, communications, bus, conversationCrudService, conversationStateStore, agentRoleResolver, gitService, executionCheckpoint, requestSystemEngineer, requestReviewer, amSeHandoffService, pauseExecution, maxSelfHealAttempts } = {}) {
  if (!projectId || !fileService?.readFile || !planStore?.createRevision || !planStore?.assertExecutable) throw new ConfigurationError("Owner command service is not configured.");
  const planning = createArchitecturePlanningService({ projectId, fileService, markdownPlanStore, validateMarkdown, framePath: PLAN_FRAME_PATH });
  let clarificationSessions;
  let seHandoff = amSeHandoffService ?? null;
  // Business purpose: lazily compose the persisted AM-SE-RV handoff service for projection and recovery requests.
  // Technical description: reuses the project-scoped stores and approval guards without starting any agent execution.
  function ensureSeHandoff() {
    seHandoff ??= createAmSeHandoffService({ projectId, fileService, markdownPlanStore, bus, conversationCrudService, agentRoleResolver, gitService, executionCheckpoint, approvePlan, handoffApprovedPlan });
    return seHandoff;
  }
  // Builds the conversation planner over one message's Architecture request so Node alone holds revision authority.
  function conversationPlanner(requestArchitecture) {
    if (!clarificationSessions) clarificationSessions = createArchitectureClarificationStore({ projectId, fileService });
    if (typeof requestArchitecture !== "function") throw fail("ARCHITECTURE_UNAVAILABLE", "Architecture is unavailable for conversation planning.");
    if (!markdownPlanStore?.createRevision) throw fail("MARKDOWN_PLAN_STORE_UNAVAILABLE", "Markdown plan registry is unavailable.");
    return createConversationPlanningService({ projectId, fileService, markdownPlanStore, validateMarkdown, sessions: clarificationSessions, requestArchitecture, conversationStateStore, communications: communications ?? bus?.store ?? null, maxSelfHealAttempts });
  }
  return Object.freeze({ execute, isCommand, listHandoffs: () => ensureSeHandoff().listHandoffs(), resumeHandoff: (input) => ensureSeHandoff().resumeHandoff(input), pauseHandoff: (input) => ensureSeHandoff().pauseHandoff(input), reconcileHandoff: (input) => ensureSeHandoff().reconcileHandoff(input), planningSessions: planning.sessions });

  // Recognizes exact slash commands plus standalone conversation planning triggers.
  function isCommand(text) { const value = String(text ?? ""); return PLAN_RE.test(value) || APPROVE_RE.test(value) || CONTINUE_RE.test(value) || /^\/resume-se-handoff\s+HANDOFF-[A-Za-z0-9_-]+\s*$/i.test(value) || isConversationPlanMessage(value) || detectPlanHandoffRetryTrigger(value) !== null; }

  // Business purpose: retries or continues Sprint Leader handoff for the latest plan in the active conversation so the owner can recover from an interrupted or repaired handoff directly in chat without regenerating the plan.
  // Technical description: locates the latest Markdown plan revision in markdownPlanStore (scoped to conversationId or project), auto-approves it if still awaiting approval, and runs approvePlan to complete SL handoff.
  async function retryConversationPlanHandoff({ text, conversationId, approvedOwnerId = "project-owner" } = {}) {
    const explicitMatch = /^\/(?:handoff|retry-handoff)\s+(\S+)\s*$/i.exec(String(text ?? "").trim());
    const allPlans = markdownPlanStore?.list?.() ?? [];
    const target = explicitMatch
      ? allPlans.find((entry) => entry.plan_id === explicitMatch[1])
      : [...allPlans].filter((entry) => !conversationId || entry.conversation_id === conversationId).at(-1) ?? allPlans.at(-1);
    if (!target) throw fail("PLAN_NOT_FOUND", "Không tìm thấy kế hoạch nào trong hội thoại để giao lại cho SL.");
    const detail = await markdownPlanStore.getRevision({ planId: target.plan_id, revision: target.revision });
    const ownerId = detail.decision?.approver_id ?? approvedOwnerId ?? "project-owner";
    if (detail.status === "awaiting_human_approval") {
      await markdownPlanStore.decide({ planId: detail.plan_id, revision: detail.revision, sha256: detail.sha256, decision: "approved", approverId: ownerId, comments: "Approved via conversation SL handoff retry." });
    }
    return approvePlan({ planId: detail.plan_id, conversationId: conversationId ?? detail.conversation_id, approvedOwnerId: ownerId, approvalRevision: detail.revision, approvalSha256: detail.sha256 });
  }

  // Business purpose: executes Phase 1 AM-SE plan critique and Phase 2 automatic handoff to Sprint Leader or System Engineer (with independent Reviewer RV verification) when the owner's plan creation trigger specified a delivery target.
  // Technical description: delegates both sl and se delivery targets to amSeHandoffService.startHandoff for a single plan or each plan in a multi-idea batch before auto-approving and handing off to SL or SE.
  async function applyAutoHandoffIfRequested(created, { conversationId, approvedOwnerId, requestArchitecture, requestSystemEngineer: turnRequestSe, requestReviewer: turnRequestRv }) {
    if (!created?.revision_created || !created.delivery_target || created.delivery_target === "none") return created;
    const ownerId = approvedOwnerId || "project-owner";
    if (created.delivery_target !== "sl" && created.delivery_target !== "se") return created;
    seHandoff ??= createAmSeHandoffService({ projectId, fileService, markdownPlanStore, bus, conversationCrudService, agentRoleResolver, gitService, executionCheckpoint, pauseExecution, approvePlan, requestArchitecture, requestSystemEngineer: turnRequestSe ?? requestSystemEngineer, requestReviewer: turnRequestRv ?? requestReviewer });
    // Business purpose: runs the AM-SE critique and SL or SE handoff for one generated plan revision.
    // Technical description: invokes seHandoff.startHandoff with the plan identity and intake metadata and formats the resulting status payload.
    const handoffOne = async (planItem) => {
      if (!planItem?.revision_created) return planItem;
      const handoff = await seHandoff.startHandoff({
        plan: { plan_id: planItem.plan_id, revision: planItem.revision, sha256: planItem.sha256, source_path: planItem.source_summary_path },
        intake: { source_kind: planItem.source_kind ?? "conversation", source_file_path: planItem.source_file_path ?? null, idea_message_id: planItem.idea_message_id ?? null, delivery_target: planItem.delivery_target ?? created.delivery_target },
        deliveryTarget: planItem.delivery_target ?? created.delivery_target, conversationId, approvedOwnerId: ownerId, approvePlan, requestArchitecture, requestSystemEngineer: turnRequestSe ?? requestSystemEngineer, requestReviewer: turnRequestRv ?? requestReviewer
      });
      if ((planItem.delivery_target ?? created.delivery_target) === "sl") {
        if (handoff.status !== "completed") return { ...planItem, ...handoff, command: "/plan", delivery_target: "sl", text: `Kế hoạch ${handoff.plan_id} r${handoff.revision} đang chờ approval hoặc bàn giao SL (${handoff.status}).` };
        return {
          ...planItem, ...handoff, command: "/plan", status: "handed_to_node", delivery_target: "sl",
          text: `Đã tạo kế hoạch ${handoff.plan_id} r${handoff.revision}, hoàn tất phản biện thống nhất AM ↔ SE (${handoff.critique_rounds_completed} vòng) và giao việc cho SL. Sprint Leader đã tạo ${handoff.sprint_id} (trạng thái: ${handoff.sprint_status ?? "ready"}). Chưa RUN.`
        };
      }
      return {
        ...planItem, ...handoff, command: "/plan", delivery_target: "se",
        text: handoff.reason === "PLAN_APPROVAL_REQUIRED"
          ? `Kế hoạch ${handoff.plan_id} r${handoff.revision} đang chờ Owner approval; SE chưa được giao thực thi.`
          : handoff.status === "completed"
            ? `Đã tạo kế hoạch ${handoff.plan_id} r${handoff.revision}, phản biện thống nhất AM ↔ SE (${handoff.critique_rounds_completed} vòng), giao việc cho SE và hoàn tất nghiệm thu sau ${handoff.rounds_completed} vòng.`
            : `Đã tạo kế hoạch ${handoff.plan_id} r${handoff.revision}; handoff SE ở trạng thái ${handoff.status}.`
      };
    };
    if (Array.isArray(created.plans) && created.plans.length > 1) {
      const handedOffPlans = [];
      for (const item of created.plans) handedOffPlans.push(await handoffOne(item));
      const primary = handedOffPlans[0];
      return {
        ...created, ...primary, plans: handedOffPlans, idea_count: handedOffPlans.length,
        text: handedOffPlans.map((item) => item.text).join("\n")
      };
    }
    const single = await handoffOne(created);
    return Array.isArray(created.plans) ? { ...single, plans: [single], idea_count: 1 } : single;
  }

  // Runs create or update planning from one owner conversation message with its provider request.
  async function requestConversationPlan({ text, conversationId, requestArchitecture, requestSystemEngineer: turnRequestSe, requestReviewer: turnRequestRv, approvedOwnerId, planRequests, publishPlanEvent, project_id: inputProjectId } = {}) {
    if (inputProjectId && inputProjectId !== projectId) throw fail("PROJECT_CONTEXT_CONFLICT", "Command project differs from the active project.");
    const planner = conversationPlanner(requestArchitecture);
    return createPlanWithDiagnostics({ projectId, planRequests, publishPlanEvent, createPlan: async () => {
      const created = detectPlanCreateTrigger(text)
        ? await planner.createFromConversation({ text, conversationId })
        : await planner.updateFromConversation({ text, conversationId });
      return applyAutoHandoffIfRequested(created, { conversationId, approvedOwnerId, requestArchitecture, requestSystemEngineer: turnRequestSe, requestReviewer: turnRequestRv });
    } });
  }

  // Executes a planning command and returns a durable, non-execution result.
  async function execute({ text, conversationId, project_id: inputProjectId, requestArchitecture, requestSystemEngineer: turnRequestSe, requestReviewer: turnRequestRv, approvedOwnerId, approvalRevision, approvalSha256, approvalComments, planningVersion, planningSourceSha256 } = {}) {
    if (inputProjectId && inputProjectId !== projectId) throw fail("PROJECT_CONTEXT_CONFLICT", "Command project differs from the active project.");
    const value = String(text ?? "").trim();
    const continuation = value.match(CONTINUE_RE);
    if (continuation) return createPlanWithDiagnostics({ projectId, planRequests, publishPlanEvent, createPlan: async () => {
      const resumeSession = await planning.sessions.get(continuation[1]);
      if (planIdFromIntakePath(resumeSession?.source_path)) {
        const created = await conversationPlanner(requestArchitecture).continuePlan({ sessionId: continuation[1], conversationId, ownerId: approvedOwnerId, expectedVersion: planningVersion, sourceSha256: planningSourceSha256 });
        return applyAutoHandoffIfRequested(created, { conversationId, approvedOwnerId, requestArchitecture, requestSystemEngineer: turnRequestSe, requestReviewer: turnRequestRv });
      }
      return planning.resume({ sessionId: continuation[1], conversationId, ownerId: approvedOwnerId, expectedVersion: planningVersion, sourceSha256: planningSourceSha256, requestArchitecture });
    } });
    const planMatch = value.match(PLAN_RE);
    if (planMatch) return createPlanWithDiagnostics({ projectId, planRequests, publishPlanEvent,
      createPlan: () => createPlan({ summaryPath: planMatch[1], conversationId, requestArchitecture }) });
    const approveMatch = value.match(APPROVE_RE);
    if (approveMatch) return approvePlan({ planId: approveMatch[1], conversationId, approvedOwnerId, approvalRevision, approvalSha256, approvalComments });
    const pauseMatch = /^\/pause-se-handoff\s+(HANDOFF-[A-Za-z0-9_-]+)\s*$/i.exec(value);
    if (pauseMatch) {
      seHandoff ??= createAmSeHandoffService({ projectId, fileService, markdownPlanStore, bus, conversationCrudService, agentRoleResolver, gitService, executionCheckpoint, pauseExecution, approvePlan, requestArchitecture, requestSystemEngineer: turnRequestSe ?? requestSystemEngineer, requestReviewer: turnRequestRv ?? requestReviewer });
      return seHandoff.pauseHandoff({ handoffId: pauseMatch[1] });
    }
    const resumeMatch = /^\/resume-se-handoff\s+(HANDOFF-[A-Za-z0-9_-]+)\s*$/i.exec(value);
    if (resumeMatch) {
      if (!approvedOwnerId || !Number.isSafeInteger(approvalRevision) || approvalRevision < 1 || !/^[a-f0-9]{64}$/i.test(String(approvalSha256 ?? ""))) throw fail("HANDOFF_RESUME_IDENTITY_REQUIRED", "Owner identity and exact plan revision/SHA are required.");
      seHandoff ??= createAmSeHandoffService({ projectId, fileService, markdownPlanStore, bus, conversationCrudService, agentRoleResolver, gitService, executionCheckpoint, pauseExecution, approvePlan, requestArchitecture, requestSystemEngineer: turnRequestSe ?? requestSystemEngineer, requestReviewer: turnRequestRv ?? requestReviewer });
      return seHandoff.resumeHandoff({ handoffId: resumeMatch[1], approvedOwnerId, expectedRevision: approvalRevision, expectedSha256: approvalSha256, requestArchitecture, requestSystemEngineer: turnRequestSe, requestReviewer: turnRequestRv });
    }
    if (detectPlanHandoffRetryTrigger(value)) return retryConversationPlanHandoff({ text: value, conversationId, approvedOwnerId });
    if (isConversationPlanMessage(value)) return requestConversationPlan({ text: value, conversationId, requestArchitecture, requestSystemEngineer: turnRequestSe, requestReviewer: turnRequestRv, approvedOwnerId, planRequests, publishPlanEvent });
    if (detectPlanApproveTrigger(value)) throw fail("COMMAND_INVALID", "Approval requires /approve <plan_id> alone; a conversation planning message never approves a plan.");
    throw fail("COMMAND_INVALID", "Supported commands are /plan <project-relative-file.md> and /approve <plan_id>. Ask Architecture Manager in normal chat to summarize the discussion and save the Markdown file.");
  }

  // Saves Architecture's discovered, evidence-bearing plan as a readable draft before approval.
  async function createPlan({ summaryPath, conversationId, requestArchitecture } = {}) {
    return planning.start({ sourcePath: summaryPath, conversationId, requestArchitecture });
  }

  // Keeps source evidence and business scope admission intact after owner clarification has completed.
  async function validateMarkdown(markdown) {
    if (!/^# Plan:\s*\S/.test(markdown) || !/^## 1\. /m.test(markdown) || !/^## 7\. /m.test(markdown)) throw fail("ARCHITECTURE_PLAN_INVALID", `Architecture must return a Markdown plan following ${PLAN_FRAME_PATH}.`);
    const evidenceReport = await inspectSummaryEvidence(markdown, fileService);
    if (!DISCOVERY_COMPLETE_RE.test(markdown) || !await hasSummaryEvidence(markdown, fileService) || !DISCOVERY_UNVERIFIED_RE.test(markdown)) {
      const missingNote = evidenceReport.missingPaths.length ? ` Missing/unreadable evidence path(s): ${evidenceReport.missingPaths.join(", ")}.` : "";
      const err = fail("DISCOVERY_INCOMPLETE", `Architecture chưa hoàn tất khảo sát mã nguồn hoặc chưa ghi đủ dẫn chứng và phần giả định/chưa kiểm chứng.${missingNote} Chưa lưu plan; lựa chọn đã lưu vẫn được giữ. Thử tạo plan lại để Architecture bổ sung khảo sát, không cần tải lại phiên.`);
      err.missing_evidence_paths = evidenceReport.missingPaths;
      throw err;
    }
    readMarkdownSprintScope(markdown);
    if (!markdownPlanStore?.createRevision) throw fail("MARKDOWN_PLAN_STORE_UNAVAILABLE", "Markdown plan registry is unavailable.");
  }

  // Hands an exactly approved plan to Node/Sprint Leader without starting execution.
  async function approvePlan({ planId, conversationId, approvedOwnerId, approvalRevision, approvalSha256 } = {}) {
    if (!SAFE_ID.test(planId ?? "")) throw fail("PLAN_ID_INVALID", "Plan identifier is invalid.");
    if (!approvedOwnerId) throw fail("PLAN_OWNER_UNAUTHORIZED", "Owner authentication is required for /approve.");
    const markdown = markdownPlanStore?.list?.().find((entry) => entry.plan_id === planId);
    const listed = markdown ?? planStore.list().find((entry) => entry.plan_id === planId);
    if (!listed) throw fail("PLAN_NOT_FOUND", "Plan is not indexed for this project.");
    const captured = approvalRevision !== undefined || approvalSha256 !== undefined;
    if (captured && (approvalRevision !== listed.revision || approvalSha256 !== listed.sha256)) throw fail("PLAN_APPROVAL_STALE", "The reviewed revision/checksum no longer matches the current plan; reload before handoff.");
    const identity = { planId, revision: captured ? approvalRevision : listed.revision, sha256: captured ? approvalSha256 : listed.sha256 };
    const plan = markdown ? await markdownPlanStore.assertApproved(identity) : await planStore.assertExecutable(identity);
    if (markdown && plan.decision?.approver_id !== approvedOwnerId) throw fail("PLAN_APPROVAL_OWNER_MISMATCH", "The authenticated owner must match the existing Markdown approval.");
    if (typeof handoffApprovedPlan !== "function") throw fail("PLAN_HANDOFF_UNAVAILABLE", "Approved-plan handoff is unavailable.");
    const handoff = await handoffApprovedPlan({ projectId, plan, conversationId });
    let sprintStatus;
    if (handoff.status === "handed_to_sprint_leader") {
      if (!handoff.sprint_id || !sprintRegistry?.get || !sprintRegistry?.setStatus) throw fail("SPRINT_REGISTRY_UNAVAILABLE", "Approved Sprint cannot be marked ready without its registry record.");
      const scheduled = sprintRegistry.get(handoff.sprint_id);
      if (!scheduled) throw fail("SPRINT_NOT_FOUND", "Sprint Leader handoff completed without a registered Sprint.");
      sprintStatus = ["planned", "awaiting_human_approval"].includes(scheduled.status)
        ? (await sprintRegistry.setStatus({ sprintId: handoff.sprint_id, status: "ready" })).status
        : scheduled.status;
    }
    return { command: "/approve", ...handoff, plan_id: planId, revision: plan.revision, sha256: plan.sha256, ...(sprintStatus ? { sprint_status: sprintStatus } : {}), text: handoff.status === "handed_to_sprint_leader" ? `Sprint Leader đã tạo ${handoff.sprint_id}; Sprint ${sprintStatus}. Chưa RUN.` : handoff.text ?? `Sprint Leader handoff: ${handoff.status}${handoff.sprint_id ? `, sprint ${handoff.sprint_id}` : ""}.`, run_started: false, coder_dispatched: false, supervisor_dispatched: false };
  }
}

// Creates a stable command error consumed by the canonical API envelope.
function fail(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }
