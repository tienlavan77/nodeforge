// Implements owner planning commands without granting execution authority.
import { ConfigurationError } from "../shared/errors.js";
import { readMarkdownSprintScope } from "../modules/governance/markdown-sprint-scope.js";
import { createPlanWithDiagnostics } from "./plan-request-diagnostics.js";
import { createArchitecturePlanningService } from "./architecture-planning-service.js";

const PLAN_RE = /^\/plan\s+(\S+)\s*$/i;
const APPROVE_RE = /^\/approve\s+(\S+)\s*$/i;
const CONTINUE_RE = /^\/plan-continue\s+(CLARIFY-[a-f0-9-]{36})\s*$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAN_FRAME_PATH = "workflows/agents/architecture/README.md";
const SUMMARY_EVIDENCE_RE = /\[(?:evidence|source):\s*(?:backend|schemas|ui|web)\/[A-Za-z0-9._/-]+(?:#L\d+(?:-L?\d+)?)?\]/i;

// Verifies planning-document references before extending the legacy code-source evidence gate.
async function hasSummaryEvidence(markdown, fileService) {
  if (SUMMARY_EVIDENCE_RE.test(markdown)) return true;
  for (const match of markdown.matchAll(/\[(?:evidence|source):\s*(`?)([^`\]\r\n]+)\1\]/gi)) {
    const reference = match[2].trim();
    const path = reference.replace(/#L[1-9]\d*(?:-L?[1-9]\d*)?$/, "");
    if (!/^(?:docs|workflows|backend|schemas|ui|web)\/[A-Za-z0-9._/-]+$/.test(path) || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) continue;
    try {
      const content = await fileService.readFile({ path });
      if (typeof content === "string" && content.trim()) return true;
    } catch (error) {
      console.warn("Summary evidence reference could not be verified.", error.code ?? error.message);
    }
  }
  return false;
}
const DISCOVERY_COMPLETE_RE = /(?:discovery complete|repository discovery complete)/i;
const DISCOVERY_UNVERIFIED_RE = /(?:assumption|unverified|unknown|uncertain)/i;

// Creates the command handler bound to one project and its immutable plan store.
export function createOwnerChatCommandService({ projectId, fileService, planStore, markdownPlanStore, handoffApprovedPlan, sprintRegistry, planRequests, publishPlanEvent } = {}) {
  if (!projectId || !fileService?.readFile || !planStore?.createRevision || !planStore?.assertExecutable) throw new ConfigurationError("Owner command service is not configured.");
  const planning = createArchitecturePlanningService({ projectId, fileService, markdownPlanStore, validateMarkdown, framePath: PLAN_FRAME_PATH });
  return Object.freeze({ execute, isCommand, planningSessions: planning.sessions });

  // Recognizes only the exact planning command forms from the human plan contract.
  function isCommand(text) { return PLAN_RE.test(String(text ?? "")) || APPROVE_RE.test(String(text ?? "")) || CONTINUE_RE.test(String(text ?? "")); }

  // Executes a planning command and returns a durable, non-execution result.
  async function execute({ text, conversationId, project_id: inputProjectId, requestArchitecture, approvedOwnerId, approvalRevision, approvalSha256, approvalComments, planningVersion, planningSourceSha256 } = {}) {
    if (inputProjectId && inputProjectId !== projectId) throw fail("PROJECT_CONTEXT_CONFLICT", "Command project differs from the active project.");
    const value = String(text ?? "").trim();
    const continuation = value.match(CONTINUE_RE);
    if (continuation) return createPlanWithDiagnostics({ projectId, planRequests, publishPlanEvent, createPlan: () => planning.resume({ sessionId: continuation[1], conversationId, ownerId: approvedOwnerId, expectedVersion: planningVersion, sourceSha256: planningSourceSha256, requestArchitecture }) });
    const planMatch = value.match(PLAN_RE);
    if (planMatch) return createPlanWithDiagnostics({ projectId, planRequests, publishPlanEvent,
      createPlan: () => createPlan({ summaryPath: planMatch[1], conversationId, requestArchitecture }) });
    const approveMatch = value.match(APPROVE_RE);
    if (approveMatch) return approvePlan({ planId: approveMatch[1], conversationId, approvedOwnerId, approvalRevision, approvalSha256, approvalComments });
    throw fail("COMMAND_INVALID", "Supported commands are /plan <project-relative-file.md> and /approve <plan_id>. Ask Architecture Manager in normal chat to summarize the discussion and save the Markdown file.");
  }

  // Saves Architecture's discovered, evidence-bearing plan as a readable draft before approval.
  async function createPlan({ summaryPath, conversationId, requestArchitecture } = {}) {
    return planning.start({ sourcePath: summaryPath, conversationId, requestArchitecture });
  }

  // Keeps source evidence and business scope admission intact after owner clarification has completed.
  async function validateMarkdown(markdown) {
    if (!/^# Plan:\s*\S/.test(markdown) || !/^## 1\. /m.test(markdown) || !/^## 7\. /m.test(markdown)) throw fail("ARCHITECTURE_PLAN_INVALID", `Architecture must return a Markdown plan following ${PLAN_FRAME_PATH}.`);
    if (!DISCOVERY_COMPLETE_RE.test(markdown) || !await hasSummaryEvidence(markdown, fileService) || !DISCOVERY_UNVERIFIED_RE.test(markdown)) throw fail("DISCOVERY_INCOMPLETE", "Repository discovery must complete with source references and labeled assumptions or unverified areas before drafting.");
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
    return { command: "/approve", status: "handed_to_node", plan_id: planId, revision: plan.revision, sha256: plan.sha256, ...handoff, ...(sprintStatus ? { sprint_status: sprintStatus } : {}), text: handoff.status === "handed_to_sprint_leader" ? `Sprint Leader đã tạo ${handoff.sprint_id}; Sprint ${sprintStatus}. Chưa RUN.` : handoff.text ?? `Sprint Leader handoff: ${handoff.status}${handoff.sprint_id ? `, sprint ${handoff.sprint_id}` : ""}.`, run_started: false, coder_dispatched: false, supervisor_dispatched: false };
  }
}

// Creates a stable command error consumed by the canonical API envelope.
function fail(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }
