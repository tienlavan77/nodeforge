// Implements owner planning commands without granting execution authority.
import { createHash, randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { readMarkdownSprintScope } from "../modules/governance/markdown-sprint-scope.js";

const SUMMARY_RE = /^\/summary\s*$/i;
const PLAN_RE = /^\/plan\s+(\S+)\s*$/i;
const APPROVE_RE = /^\/approve\s+(\S+)\s*$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAN_FRAME_PATH = "workflows/agents/architecture/README.md";
const SUMMARY_PATH_PREFIX = ".forge/runtime/nf/summary/";
const SUMMARY_SECTIONS = ["Goals", "In Scope", "Out of Scope", "Decisions", "Assumptions", "Risks", "Open Questions"];
const SUMMARY_EVIDENCE_RE = /\[(?:evidence|source):\s*(?:backend|schemas|ui|web)\/[A-Za-z0-9._/-]+(?:#L\d+(?:-L?\d+)?)?\]/i;
const SUMMARY_UNCERTAINTY_RE = /\b(?:assumption|assumes|unknown|uncertain|not known)\b/i;

// Creates the command handler bound to one project and its immutable plan store.
export function createOwnerChatCommandService({ projectId, fileService, communications, planStore, markdownPlanStore, handoffApprovedPlan, sprintRegistry } = {}) {
  if (!projectId || !fileService?.readFile || !fileService?.atomicCreate || !planStore?.createRevision || !planStore?.assertExecutable) throw new ConfigurationError("Owner command service is not configured.");
  return Object.freeze({ execute, isCommand });

  // Recognizes only the exact planning command forms from the human plan contract.
  function isCommand(text) { return SUMMARY_RE.test(String(text ?? "")) || PLAN_RE.test(String(text ?? "")) || APPROVE_RE.test(String(text ?? "")); }

  // Executes a planning command and returns a durable, non-execution result.
  async function execute({ text, conversationId, project_id: inputProjectId, requestArchitecture, approvedOwnerId, approvalRevision, approvalSha256, approvalComments } = {}) {
    if (inputProjectId && inputProjectId !== projectId) throw fail("PROJECT_CONTEXT_CONFLICT", "Command project differs from the active project.");
    const value = String(text ?? "").trim();
    if (SUMMARY_RE.test(value)) return createSummary({ conversationId, requestArchitecture });
    const planMatch = value.match(PLAN_RE);
    if (planMatch) return createPlan({ summaryId: planMatch[1], conversationId, requestArchitecture });
    const approveMatch = value.match(APPROVE_RE);
    if (approveMatch) return approvePlan({ planId: approveMatch[1], conversationId, approvedOwnerId, approvalRevision, approvalSha256, approvalComments });
    throw fail("COMMAND_INVALID", "Supported commands are /summary, /plan <id-file>, and /approve <plan_id>.");
  }

  // Saves only a validated discussion summary as a temporary planning input artifact.
  async function createSummary({ conversationId, requestArchitecture } = {}) {
    if (typeof requestArchitecture !== "function") throw fail("ARCHITECTURE_UNAVAILABLE", "Architecture agent is unavailable.");
    const contract = [
      "Produce a temporary planning input only; do not produce a plan, authorize execution, or claim approval.",
      "Return Markdown with exactly these substantive sections: # Discussion Summary, and ## Goals, ## In Scope, ## Out of Scope, ## Decisions, ## Assumptions, ## Risks, ## Open Questions.",
      "Every repository fact must include an actual reference such as [Evidence: backend/src/example.js]. Mark uncertain claims as assumptions or unknowns.",
      `The resolved runtime artifact path is ${SUMMARY_PATH_PREFIX}<SUMMARY-uuid>.md; this response is the source content only. Summarize the recent owner discussion, not unrelated repository work.`,
    ].join("\n");
    const discussionContext = (communications?.getByConversationId?.(conversationId) ?? []).slice(-20).map(({ sender, payload }) => `${sender?.id ?? "unknown"}: ${payload?.text ?? ""}`).filter(Boolean).join("\n") || "No owner discussion context is available.";
    const architectureText = String(await requestArchitecture(`${contract}\n\n## Recent Owner Discussion\n${discussionContext}`, conversationId) ?? "").trim();
    validateSummary(architectureText);
    const id = `SUMMARY-${randomUUID()}`;
    const path = `${SUMMARY_PATH_PREFIX}${id}.md`;
    await fileService.atomicCreate({ path, content: `${architectureText}\n` });
    return { command: "/summary", status: "created", summary_id: id, file_id: id, path, text: `Summary created: ${id}`, execution_authorized: false, plan_created: false };
  }

  // Rejects planning-shaped or unverifiable summaries before temporary persistence.
  function validateSummary(markdown) {
    if (!markdown.startsWith("# Discussion Summary")) throw fail("SUMMARY_INVALID", "Summary must start with a Discussion Summary heading.");
    for (const section of SUMMARY_SECTIONS) {
      const heading = `## ${section}`;
      if (!markdown.split("\n").some((line) => line.trim() === heading)) throw fail("SUMMARY_INVALID", `Summary is missing the ${section} section.`);
    }
    if (!SUMMARY_EVIDENCE_RE.test(markdown)) throw fail("SUMMARY_EVIDENCE_MISSING", "Repository facts require an [Evidence: path] or [Source: path] reference.");
    if (!SUMMARY_UNCERTAINTY_RE.test(markdown)) throw fail("SUMMARY_UNCERTAINTY_MISSING", "Uncertain claims must be labeled as assumptions or unknowns.");
    if (/^# Plan:|execution authorized|approved to run/i.test(markdown)) throw fail("SUMMARY_NOT_INPUT", "Summary generation cannot create a plan or execution authorization.");
  }

  // Saves Architecture's plan as a readable draft before any approval artifact is created.
  async function createPlan({ summaryId, conversationId, requestArchitecture } = {}) {
    if (!SAFE_ID.test(summaryId ?? "") || !summaryId.startsWith("SUMMARY-")) throw fail("SUMMARY_ID_INVALID", "Summary identifier is invalid for this project.");
    const path = `.forge/runtime/nf/summary/${summaryId}.md`;
    let summary;
    try { summary = await fileService.readFile({ path }); } catch (error) { throw fail("SUMMARY_NOT_FOUND", `Summary is unavailable: ${error.code ?? error.message}.`); }
    let frame;
    try { frame = await fileService.readFile({ path: PLAN_FRAME_PATH }); } catch (error) { throw fail("PLAN_FRAME_NOT_FOUND", `Plan frame is unavailable: ${error.code ?? error.message}.`); }
    if (typeof requestArchitecture !== "function") throw fail("ARCHITECTURE_UNAVAILABLE", "Architecture agent is unavailable.");
    const prompt = `Dựa trên summary và khung kế hoạch dưới đây, hãy thiết kế một plan dễ đọc cho owner. Chỉ trả về Markdown theo khung; không trả JSON, không tạo file, không tuyên bố đã được duyệt hoặc đã RUN.\n\n## Summary nguồn (${summaryId})\n\n${summary}\n\n## Khung kế hoạch (${PLAN_FRAME_PATH})\n\n${frame}`;
    const markdown = String(await requestArchitecture(prompt, conversationId) ?? "").trim();
    if (!/^# Plan:\s*\S/.test(markdown) || !/^## 1\. /m.test(markdown) || !/^## 7\. /m.test(markdown)) throw fail("ARCHITECTURE_PLAN_INVALID", `Architecture must return a Markdown plan following ${PLAN_FRAME_PATH}.`);
    readMarkdownSprintScope(markdown);
    const planId = `PLAN-${projectId}-${randomUUID()}`;
    if (!markdownPlanStore?.createRevision) throw fail("MARKDOWN_PLAN_STORE_UNAVAILABLE", "Markdown plan registry is unavailable.");
    const draft = await markdownPlanStore.createRevision({ planId, markdown, summaryPath: path, summarySha256: createHash("sha256").update(summary).digest("hex"), conversationId });
    return { command: "/plan", status: draft.status, plan_id: planId, revision: draft.revision, sha256: draft.sha256, file_id: planId, path: draft.file_path, source_summary_id: summaryId, conversation_id: conversationId ?? null, text: `Đã tạo kế hoạch ${planId}. Chờ duyệt.`, run_started: false };
  }

  // Hands an exactly approved plan to Node/Sprint Leader without starting execution.
  async function approvePlan({ planId, conversationId, approvedOwnerId, approvalRevision, approvalSha256, approvalComments } = {}) {
    if (!SAFE_ID.test(planId ?? "")) throw fail("PLAN_ID_INVALID", "Plan identifier is invalid.");
    if (!approvedOwnerId) throw fail("PLAN_OWNER_UNAUTHORIZED", "Owner authentication is required for /approve.");
    const markdown = markdownPlanStore?.list?.().find((entry) => entry.plan_id === planId);
    const listed = markdown ?? planStore.list().find((entry) => entry.plan_id === planId);
    if (!listed) throw fail("PLAN_NOT_FOUND", "Plan is not indexed for this project.");
    if (markdown && (approvalRevision !== listed.revision || approvalSha256 !== listed.sha256)) throw fail("PLAN_DECISION_STALE", "Approve the exact Markdown revision and SHA displayed to the owner.");
    if (markdown && !(await markdownPlanStore.getRevision({ planId, revision: listed.revision })).decision) await markdownPlanStore.decide({ planId, revision: listed.revision, sha256: listed.sha256, decision: "approved", approverId: approvedOwnerId, comments: approvalComments ?? null });
    const plan = markdown ? await markdownPlanStore.assertApproved({ planId, revision: listed.revision, sha256: listed.sha256 }) : await planStore.assertExecutable({ planId, revision: listed.revision, sha256: listed.sha256 });
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
