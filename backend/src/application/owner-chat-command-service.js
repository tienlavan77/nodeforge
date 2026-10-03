// Implements owner planning commands without granting execution authority.
import { createHash, randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { readMarkdownSprintScope } from "../modules/governance/markdown-sprint-scope.js";

const SUMMARY_RE = /^\/summary\s*$/i;
const PLAN_RE = /^\/plan\s+(\S+)\s*$/i;
const APPROVE_RE = /^\/approve\s+(\S+)\s*$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAN_FRAME_PATH = "workflows/frame-plan.md";

// Creates the command handler bound to one project and its immutable plan store.
export function createOwnerChatCommandService({ projectId, fileService, planStore, markdownPlanStore, handoffApprovedPlan } = {}) {
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

  // Saves only the recent conversation as a temporary planning input artifact.
  async function createSummary({ conversationId, requestArchitecture } = {}) {
    if (typeof requestArchitecture !== "function") throw fail("ARCHITECTURE_UNAVAILABLE", "Architecture agent is unavailable.");
    const architectureText = await requestArchitecture("Bạn hãy tổng hợp lại các trao đổi đã thống nhất với owner.", conversationId);
    const id = `SUMMARY-${randomUUID()}`;
    const path = `.forge/runtime/nf/summary/${id}.md`;
    await fileService.atomicWrite({ path, content: `${architectureText.trim()}\n`, replace: true });
    return { command: "/summary", status: "created", summary_id: id, file_id: id, path, text: `Summary đã tạo: ${id}`, execution_authorized: false };
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
    if (!/^# Plan:\s*\S/.test(markdown) || !/^## 1\. /m.test(markdown) || !/^## 7\. /m.test(markdown)) throw fail("ARCHITECTURE_PLAN_INVALID", "Architecture must return a Markdown plan following frame-plan.md.");
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
    return { command: "/approve", status: "handed_to_node", plan_id: planId, revision: plan.revision, sha256: plan.sha256, ...handoff, text: handoff.text ?? `Sprint Leader handoff: ${handoff.status}${handoff.sprint_id ? `, sprint ${handoff.sprint_id}` : ""}.`, run_started: false, coder_dispatched: false, supervisor_dispatched: false };
  }
}

// Creates a stable command error consumed by the canonical API envelope.
function fail(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }
