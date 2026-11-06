// Business purpose: orchestrates Phase 1 AM-SE plan critique (1-2 rounds between Architecture Manager as plan author and System Engineer as technical reviewer) for all automatic handoff targets, followed by Phase 2 execution handoff to either Sprint Leader (SL) or System Engineer (SE).
// Technical description: coordinates human-readable Markdown brief formatting, dual-conversation bus messaging, 1-2 round AM-SE plan critique with optional RFC 7396 r2 revision update, auto-approval in markdownPlanStore, SL sprint handoff, and multi-round SE implementation with AM acceptance review ([VERDICT: PASS] vs [VERDICT: REVISE]).
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { appendArchitectureDecisions, readArchitectureDecisions } from "../modules/governance/architecture-owner-decisions.js";
import { architectureSessionFromRecord, canonicalArchitecturePlanSha256, canonicalizeArchitecturePlanJSON, mergeArchitecturePlanJSON, parseArchitecturePlanJSON, renderArchitecturePlanMarkdown } from "../modules/governance/architecture-plan-json.js";
import { retainConversationPlanSource } from "../modules/governance/conversation-plan-source.js";
import { createAmSeHandoffStore } from "./am-se-handoff-store.js";
import { createAmSeHandoffCheckpoint } from "./am-se-handoff-checkpoint.js";
import { createAmSeCritiqueCheckpoint } from "./am-se-critique-checkpoint.js";

// Business purpose: formats an Architecture Plan JSON object into a clear, natural-language Markdown brief so human readers and the System Engineer can review and critique the plan without reading raw JSON dumps.
// Technical description: renders the plan title, metadata, delivery target (SL or SE), objective, background, itemized outcomes with acceptance criteria and guardrails, evidence references, verification instructions, a critique invitation, and the canonical JSON source path.
export function formatHumanReadableHandoffBrief(planJson, { planId, revision = 1, sourceKind = "conversation", sourceFilePath = null, planSourcePath = null, deliveryTarget = "se" } = {}) {
  const sourceLabel = sourceKind === "markdown_file" && sourceFilePath ? `từ tài liệu đặc tả \`${sourceFilePath}\`` : "từ cuộc trao đổi kiến trúc";
  const targetLabel = deliveryTarget === "sl" ? "Sprint Leader (SL)" : "System Engineer (SE)";
  const outcomes = (planJson?.outcomes ?? []).map((item) => [
    `### Hạng mục ${item.id}: ${item.outcome}`,
    ...(item.acceptance_criteria ?? []).map((ac) => `  - Tiêu chí hoàn thành: ${ac}`),
    ...(item.guardrails ?? []).map((gr) => `  - Ranh giới & lưu ý: ${gr}`)
  ].join("\n")).join("\n\n");
  const evidenceList = Array.isArray(planJson?.evidence) && planJson.evidence.length
    ? planJson.evidence.map((ev) => `- \`${ev.path}\`${ev.location ? ` (${ev.location})` : ""}: ${ev.fact}`).join("\n")
    : "- Xem trong hồ sơ kế hoạch gốc.";
  const scopeList = Array.isArray(planJson?.scope) && planJson.scope.length ? planJson.scope.map((s) => `- ${s}`).join("\n") : "";
  return [
    `## Trình bày & Phản biện kế hoạch kiến trúc (Đích giao việc: ${targetLabel}): ${planJson?.title ?? planId}`, "",
    `Architecture Manager (người viết kế hoạch) đã hoàn tất bản dự thảo **${planId} (r${revision})** ${sourceLabel}, dự kiến bàn giao thực thi cho **${targetLabel}**.`, "",
    "### 1. Mục tiêu tổng thể", planJson?.objective ?? "",
    ...(planJson?.background ? ["", "**Bối cảnh:**", planJson.background] : []),
    ...(scopeList ? ["", "### 2. Phạm vi thực hiện", scopeList] : []), "",
    "### 3. Các hạng mục công việc & Tiêu chí nghiệm thu", outcomes, "",
    "### 4. Khu vực mã nguồn tham chiếu & Kiểm thử xác nhận", "**Mã nguồn liên quan:**", evidenceList, "",
    `**Phương thức kiểm thử & nghiệm thu:** ${planJson?.verification ?? "Chạy kiểm thử đơn vị và kiểm tra tĩnh cho các file thay đổi."}`, "",
    "### 5. Mời System Engineer phản biện kế hoạch",
    "Mời **System Engineer (SE)** khảo sát nhanh các file mã nguồn liên quan và cho ý kiến phản biện kỹ thuật (tính khả thi, điểm xung đột với code hiện tại, rủi ro hoặc đề xuất cải thiện cấu trúc `outcomes`/`guardrails`) trước khi chốt phương án giao việc. Kết thúc phản hồi bằng `[CRITIQUE: ALIGNED]` nếu đã đồng thuận hoặc `[CRITIQUE: DISCUSS]` nếu cần điều chỉnh.",
    ...(planSourcePath ? ["", `_Hồ sơ kế hoạch gốc: ${planSourcePath}_`] : [])
  ].join("\n");
}

// Business purpose: extracts the System Engineer's plan critique status ([CRITIQUE: ALIGNED] or [CRITIQUE: DISCUSS]) while keeping the human-readable critique prose clean.
// Technical description: matches the trailing [CRITIQUE: ALIGNED|DISCUSS] tag case-insensitively and returns both the normalized status and cleaned text.
export function parseSePlanCritique(rawText) {
  const text = String(rawText ?? "").trim();
  const allMatches = [...text.matchAll(/[`*_~]*\[\s*CRITIQUE\s*:\s*(ALIGNED|DISCUSS)\s*\][`*_~]*/gi)];
  const lastMatch = allMatches.at(-1);
  const status = lastMatch ? lastMatch[1].toUpperCase() : /\bCRITIQUE\s*:\s*DISCUSS\b/i.test(text) ? "DISCUSS" : "ALIGNED";
  const cleanText = text.replace(/\s*[`*_~]*\[\s*CRITIQUE\s*:\s*(?:ALIGNED|DISCUSS)\s*\][`*_~]*\s*$/i, "").trim();
  return { status, cleanText: cleanText || text };
}

// Business purpose: extracts the terminal coordination verdict ([VERDICT: PASS] or [VERDICT: REVISE]) from the Architecture Manager's review response while keeping the human-facing review prose clean.
// Technical description: matches the trailing [VERDICT: PASS|REVISE] marker case-insensitively and returns both the normalized verdict and the cleaned display text.
export function parseAmReviewVerdict(rawText) {
  const text = String(rawText ?? "").trim();
  const terminal = /(?:^|\n)\s*[`*_~]*\[\s*VERDICT\s*:\s*(PASS|REVISE)\s*\][`*_~]*\s*$/i.exec(text);
  const cleanText = terminal ? text.slice(0, terminal.index).trim() : text;
  return { verdict: terminal && cleanText ? terminal[1].toUpperCase() : null, cleanText };
}

/**
 * Business purpose: extracts the independent Reviewer's verdict ([VERDICT: PASS] or [VERDICT: REVISE]) and cleaned review findings during an AM-SE-RV execution cycle.
 * Technical description: delegates to parseAmReviewVerdict so RV and AM share the same deterministic [VERDICT: PASS|REVISE] parsing contract.
 */
export function parseRvReviewVerdict(rawText) {
  return parseAmReviewVerdict(rawText);
}

// Business purpose: builds the prompt asking the Architecture Manager to respond to the System Engineer's Round 1 plan critique and optionally emit an RFC 7396 JSON merge patch if the plan needs adjustment to r2.
// Technical description: combines the canonical plan JSON and the System Engineer's critique remarks, instructing AM to answer in natural language and optionally include a fenced json merge patch block.
function buildAmCritiqueReplyPrompt({ planJson, planId, seCritiqueText }) {
  return [
    `Architecture plan critique response (${planId}, round 1).`,
    "System Engineer reviewed your plan and raised points for discussion.",
    "Reply in clear, natural language addressing each point so the Project Owner and System Engineer can follow the discussion.",
    "If you agree to adjust the plan, you may also include a single ```json ... ``` RFC 7396 merge patch block at the end of your reply to update the canonical plan to revision 2.",
    "", "Current canonical plan:", JSON.stringify(planJson), "",
    "System Engineer critique:", String(seCritiqueText ?? "")
  ].join("\n");
}

// Business purpose: builds the prompt asking the Architecture Manager to inspect the System Engineer's completed work against the canonical plan outcomes and write a clear, human-readable acceptance review.
// Technical description: combines the canonical plan outcomes, the current round number, and the System Engineer's turn summary, instructing AM to explain passed and remaining items in natural language and end with [VERDICT: PASS] or [VERDICT: REVISE].
/**
 * Business purpose: builds the prompt asking the independent Reviewer (RV) to inspect the System Engineer's code changes in read-only mode before Architecture Manager acceptance.
 * Technical description: combines the canonical plan outcomes/guardrails, current round number, and SE's implementation report, instructing RV to verify changed files and conventions (250 lines for .md, 400 code_lines for code) using read-only tools and end with [VERDICT: PASS] or [VERDICT: REVISE].
 */
function buildRvImplementationReviewPrompt({ planJson, planId, round, maxRounds, seReplyText }) {
  const outcomesSummary = (planJson?.outcomes ?? []).map((o) => `- ${o.id} (${o.outcome}): Tiêu chí: ${(o.acceptance_criteria ?? []).join("; ")} | Guardrails: ${(o.guardrails ?? []).join("; ")}`).join("\n");
  return [
    `Independent Reviewer (RV) verification for System Engineer implementation (${planId}, round ${round}/${maxRounds}).`,
    "Operate strictly in read-only mode: use your read-only Forge tools (read_file, Read, search_text, list_files, search_tree, git_status, git_diff) to inspect the System Engineer's changes against the plan outcomes, guardrails, test evidence, and repository conventions (at most 250 lines for .md files and 400 code_lines for code files). Never modify files.",
    "Write a clear, constructive review in natural language:",
    "1. Summarize verified implementation evidence and test coverage.",
    "2. List any defects, missing acceptance criteria, or guardrail violations with exact file paths and actionable repair instructions for SE.",
    "3. On the final line of your response, append exactly [VERDICT: PASS] if the implementation is ready for Architecture Manager acceptance, or [VERDICT: REVISE] if SE must fix issues first.",
    "", "Plan outcomes, acceptance criteria, and guardrails:", outcomesSummary, "",
    `System Engineer round ${round} report:`, String(seReplyText ?? "(No text returned)")
  ].join("\n");
}

function buildAmAcceptanceReviewPrompt({ planJson, planId, round, maxRounds, seReplyText, rvReviewText = "" }) {
  const outcomesSummary = (planJson?.outcomes ?? []).map((o) => `- ${o.id} (${o.outcome}): Tiêu chí: ${(o.acceptance_criteria ?? []).join("; ")}`).join("\n");
  return [
    `Architecture acceptance review for System Engineer handoff (${planId}, round ${round}/${maxRounds}).`,
    "Use your read-only Forge tools (read_file, Read, search_text, git_status, git_diff) if needed to verify the System Engineer's implementation and the Reviewer's independent verification against every outcome and acceptance criterion below.",
    "Write your review in clear, natural language for the human Project Owner and System Engineer:",
    "1. Summarize the overall progress of this round.",
    "2. List each outcome (O1, O2, ...), clearly marking what is completed and what still needs adjustment (with specific file/behavior guidance if anything is incomplete).",
    "3. On the final line of your response, append exactly [VERDICT: PASS] if all acceptance criteria are satisfied, or [VERDICT: REVISE] if another revision round is required.",
    "", "Plan outcomes and acceptance criteria:", outcomesSummary, "",
    `System Engineer round ${round} report:`, String(seReplyText ?? "(No text returned)"),
    ...(rvReviewText ? ["", `Independent Reviewer (RV) round ${round} assessment ([VERDICT: PASS]):`, String(rvReviewText)] : [])
  ].join("\n");
}

// Business purpose: creates the orchestration service that manages Phase 1 AM-SE plan critique and Phase 2 automatic handoffs to Sprint Leader or System Engineer (with independent Reviewer RV verification).
// Technical description: wires fileService, markdownPlanStore, bus, conversationCrudService, agentRoleResolver, approvePlan, requestArchitecture, requestSystemEngineer, and requestReviewer into startHandoff.
export function createAmSeHandoffService({
  projectId, fileService, markdownPlanStore, handoffStore, gitService, executionCheckpoint, pauseExecution, bus, agentRoleResolver, approvePlan, requestArchitecture, requestSystemEngineer, requestReviewer, maxCritiqueRounds = 2, maxRounds = 5
} = {}) {
  if (!projectId || !fileService?.readFile || !markdownPlanStore?.decide) {
    throw Object.assign(new ConfigurationError("AM-SE handoff service requires projectId, FileService, and markdownPlanStore."), { code: "SE_HANDOFF_UNAVAILABLE", statusCode: 503 });
  }
  const store = handoffStore ?? createAmSeHandoffStore({ projectId, fileService });
  const checkpoint = gitService ? createAmSeHandoffCheckpoint({ store, markdownPlanStore, fileService, gitService, projectId, executionCheckpoint, pauseExecution }) : null;
  const critique = createAmSeCritiqueCheckpoint({ store, fileService, executionCheckpoint, gitService, projectId });

  // Business purpose: publishes a communication message to both the Architecture conversation and the System Engineer conversation so human observers see the full dialogue in either workspace.
  // Technical description: sends a message on the shared bus for amConversationId (with linked_conversation_id pointing to seConversationId) and mirrors it to seConversationId when bus.send is available.
  function publishDualConversationMessage({ sender, recipient, messageType, amConversationId, seConversationId, correlationId, text, extraPayload = {} }) {
    if (typeof bus?.send !== "function") return;
    const timestamp = new Date().toISOString();
    const basePayload = { text, content_type: "text/markdown", agent_status: "COMPLETED", ...extraPayload };
    if (amConversationId) {
      bus.send({ id: `MSG-HANDOFF-AM-${randomUUID()}`, project_id: projectId, sender, recipient, message_type: messageType, conversation_id: amConversationId, correlation_id: correlationId, payload: { ...basePayload, linked_conversation_id: seConversationId ?? null }, timestamp });
    }
  }

  // Business purpose: applies an optional RFC 7396 JSON merge patch emitted by AM during plan critique so agreed improvements become revision r2 before approval.
  // Technical description: extracts a fenced json block from AM's critique response, merges and validates the updated plan, locks the r2 source anchor and markdown revision, and returns the updated plan metadata and cleaned message text.
  async function maybeApplyCritiqueRevision({ rawAmReply, currentPlan, currentPlanJson, conversationId }) {
    const fenceMatch = /```json\s*([\s\S]*?)```/i.exec(rawAmReply);
    const cleanReply = rawAmReply.replace(/```json\s*[\s\S]*?```/gi, "").trim() || rawAmReply.trim();
    if (!fenceMatch?.[1]?.trim() || !markdownPlanStore.createRevision) return { cleanReply, currentPlan, currentPlanJson };
    try {
      const merged = mergeArchitecturePlanJSON(canonicalizeArchitecturePlanJSON(currentPlanJson), fenceMatch[1].trim());
      const nextRevision = currentPlan.revision + 1;
      const baseMarkdown = renderArchitecturePlanMarkdown({ plan: merged, planId: currentPlan.plan_id, revision: nextRevision, sourceSha256: canonicalArchitecturePlanSha256(merged) });
      const anchor = await retainConversationPlanSource({ fileService, planId: currentPlan.plan_id, revision: nextRevision, canonicalBytes: canonicalizeArchitecturePlanJSON(merged) });
      const prev = await markdownPlanStore.getRevision({ planId: currentPlan.plan_id, revision: currentPlan.revision });
      const record = readArchitectureDecisions(prev?.markdown ?? "");
      const decisionSession = record?.decisions?.length ? architectureSessionFromRecord(record) : { session_id: `${currentPlan.plan_id}-R${nextRevision}`, source_path: anchor.path, source_sha256: anchor.sha256, owner_id: null, confirmed_at: null, questions: [], selections: {}, notes: {} };
      const stored = await markdownPlanStore.createRevision({ planId: currentPlan.plan_id, expectedRevision: currentPlan.revision, markdown: appendArchitectureDecisions(baseMarkdown, decisionSession), summaryPath: anchor.path, summarySha256: anchor.sha256, conversationId });
      return { cleanReply, currentPlan: { plan_id: stored.plan_id, revision: stored.revision, sha256: stored.sha256, source_path: anchor.path }, currentPlanJson: merged };
    } catch (err) {
      void err;
      return { cleanReply, currentPlan, currentPlanJson };
    }
  }

  // Business purpose: resumes a saved handoff from the next durable SE, RV, or AM step.
  // Technical description: checks exact Owner approval, invokes only the role selected by the checkpoint, and retains each result before advancing.
  async function resumeHandoff({ handoffId, approvedOwnerId, requestSystemEngineer: se = requestSystemEngineer, requestReviewer: rv = requestReviewer, requestArchitecture: am = requestArchitecture, drain = false, expectedRevision, expectedSha256 } = {}) {
    if (!checkpoint) throw Object.assign(new ConfigurationError("Handoff checkpoint is unavailable."), { code: "HANDOFF_CHECKPOINT_UNAVAILABLE", statusCode: 503 });
    let record = await store.get(handoffId);
    if (!record || record.project_id !== projectId || record.delivery_target !== "se" || !approvedOwnerId || record.am_conversation_id == null) throw Object.assign(new ConfigurationError("Handoff identity is unavailable."), { code: "HANDOFF_IDENTITY_INVALID", statusCode: 409 });
    if (expectedRevision !== undefined && expectedRevision !== record.plan_revision || expectedSha256 !== undefined && expectedSha256 !== record.plan_sha256) throw Object.assign(new ConfigurationError("Plan identity changed."), { code: "HANDOFF_PLAN_MISMATCH", statusCode: 409 });
    let approved;
    if (record.checkpoint && !record.checkpoint.approval_pending) {
      if (!record.checkpoint.approved_owner_id) throw Object.assign(new ConfigurationError("Checkpoint has no recorded Owner approval; re-approve the plan before resuming."), { code: "PLAN_APPROVAL_REQUIRED", statusCode: 409 });
      if (record.checkpoint.approved_owner_id !== approvedOwnerId) throw Object.assign(new ConfigurationError("Owner approval does not match the checkpoint owner."), { code: "PLAN_APPROVAL_OWNER_MISMATCH", statusCode: 409 });
      approved = { decision: { approver_id: approvedOwnerId } };
    } else {
      try {
        approved = await checkpoint.verifyPlan(record);
      } catch (error) {
        if (error?.code === "PLAN_APPROVAL_REQUIRED") throw Object.assign(new ConfigurationError("AM-SE handoff requires exact Owner approval before SE execution."), { code: "PLAN_APPROVAL_REQUIRED", statusCode: 409, cause: error });
        throw error;
      }
    }
    if (approved.decision?.approver_id !== approvedOwnerId) throw Object.assign(new ConfigurationError("Owner approval does not match."), { code: "PLAN_APPROVAL_OWNER_MISMATCH", statusCode: 409 });
    if (record.checkpoint?.approval_pending) record = await checkpoint.initialize(handoffId, approvedOwnerId);
    if (!record.checkpoint) {
      if (record.phase !== "plan_critique" || record.status !== "paused" || !record.history?.length || record.history.at(-1)?.critique_status !== "ALIGNED" || record.history.at(-1)?.critique_round !== record.critique_round) throw Object.assign(new ConfigurationError("Critique cannot resume safely."), { code: "HANDOFF_CRITIQUE_REQUIRED", statusCode: 409 });
      record = await store.transition(handoffId, 0, (current) => {
        if (current.phase !== "plan_critique" || current.status !== "paused" || current.plan_revision !== record.plan_revision || current.plan_sha256 !== record.plan_sha256 || current.checkpoint) throw Object.assign(new ConfigurationError("Handoff changed."), { code: "HANDOFF_STALE", statusCode: 409 });
        return { ...current, phase: "implementation", status: "running", round: 1, checkpoint: { generation: 0, approval_pending: true } };
      });
      record = await checkpoint.initialize(handoffId, approvedOwnerId);
    }
    const planJson = parseArchitecturePlanJSON(await fileService.readFile({ path: record.plan_source_path }));
    const invoke = async ({ record: active, step, round, executionId, previous }) => {
      const seResult = [...previous].reverse().find((item) => item.round === round && item.step === "se");
      const rvResult = [...previous].reverse().find((item) => item.round === round && item.step === "rv");
      const preceding = previous.at(-1);
      const prompt = step === "se"
        ? preceding?.verdict === "REVISE" ? `Please address the saved ${preceding.step.toUpperCase()} findings for round ${round}:\n${preceding.text}` : `Implement approved plan ${active.plan_id} r${active.plan_revision} (${active.plan_source_path}). Report implementation and verification evidence.`
        : step === "rv" ? buildRvImplementationReviewPrompt({ planJson, planId: active.plan_id, round, maxRounds: active.max_rounds, seReplyText: seResult?.text })
          : buildAmAcceptanceReviewPrompt({ planJson, planId: active.plan_id, round, maxRounds: active.max_rounds, seReplyText: seResult?.text, rvReviewText: rvResult?.text });
      let raw;
      if (step === "se" && typeof se === "function") raw = await se({ agentId: active.se_agent_id, prompt, conversationId: active.se_conversation_id, linkedConversationId: active.am_conversation_id, correlationId: executionId, phase: "implementation", round, withEvidence: true });
      else if (step === "rv" && typeof rv === "function") raw = await rv({ agentId: active.rv_agent_id, prompt, conversationId: active.rv_conversation_id, linkedConversationId: active.am_conversation_id, correlationId: executionId, phase: "implementation", round, withEvidence: true });
      else if (step === "am" && typeof am === "function") raw = await am(prompt, active.am_conversation_id, { responseContentType: "text/markdown", exposeText: false, correlationId: executionId, withEvidence: true });
      else throw Object.assign(new ConfigurationError("Role stream unavailable."), { code: "HANDOFF_ADAPTER_UNAVAILABLE" });
      const parsed = step === "se" ? { cleanText: String(raw?.text ?? "").trim() } : parseAmReviewVerdict(raw?.text);
      return { execution_id: raw?.execution_id, terminal_status: raw?.terminal_status, result_evidence: raw?.result_evidence, read_only_enforced: raw?.read_only_enforced, text: parsed.cleanText, ...(step === "se" ? {} : { verdict: parsed.verdict }) };
    };
    let pending = true;
    while (pending) {
      record = await checkpoint.resume(handoffId, { invoke, recoverResult: (step, receipt) => {
        const parsed = step === "se" ? { cleanText: receipt.text } : parseAmReviewVerdict(receipt.text);
        return { ...receipt, text: parsed.cleanText, ...(step === "se" ? {} : { verdict: parsed.verdict }) };
      }, expectedRevision: record.plan_revision, expectedSha256: record.plan_sha256, expectedOwnerId: approvedOwnerId });
      pending = drain && record.checkpoint.execution_status === "pending";
    }
    return { handoff_id: record.handoff_id, phase: record.phase, status: record.status, reason: record.checkpoint.error_code, delivery_target: record.delivery_target, plan_id: record.plan_id, revision: record.plan_revision, sha256: record.plan_sha256, rounds_completed: record.checkpoint.round, history: record.history, checkpoint: record.checkpoint };
  }

  // Business purpose: resumes only the next incomplete AM-SE critique turn from its durable checkpoint.
  // Technical description: reconstructs the role prompt from the pinned plan and saved critique result, invokes one role, and leaves implementation approval to the existing backend gate.
  async function resumeCritique({ handoffId, requestSystemEngineer: se = requestSystemEngineer, requestArchitecture: am = requestArchitecture } = {}) {
    const record = await store.get(handoffId);
    const cp = record?.critique_checkpoint;
    if (!record || !cp || record.phase !== "plan_critique") throw Object.assign(new ConfigurationError("Critique checkpoint is unavailable."), { code: "HANDOFF_CRITIQUE_REQUIRED", statusCode: 409 });
    const planJson = parseArchitecturePlanJSON(await fileService.readFile({ path: record.plan_source_path }));
    const previousSe = cp.results.find((item) => item.step === "se" && item.round === cp.round);
    const brief = formatHumanReadableHandoffBrief(planJson, { planId: record.plan_id, revision: record.plan_revision, planSourcePath: record.plan_source_path, deliveryTarget: record.delivery_target });
    const step = cp.next_step ?? cp.current_step;
    const prompt = step === "se"
      ? `${brief}\n\n[Giai đoạn 1 - Resume phản biện kế hoạch, vòng ${cp.round}/${record.max_critique_rounds}]: Hãy phản biện kỹ thuật kế hoạch và kết thúc bằng [CRITIQUE: ALIGNED] hoặc [CRITIQUE: DISCUSS].`
      : buildAmCritiqueReplyPrompt({ planJson, planId: record.plan_id, seCritiqueText: previousSe?.text ?? "" });
    const turn = await critique.run(handoffId, { step, round: cp.round, invoke: (executionId) => step === "se"
      ? se?.({ agentId: record.se_agent_id, prompt, conversationId: record.se_conversation_id, linkedConversationId: record.am_conversation_id, correlationId: executionId, phase: "plan_critique", critiqueRound: cp.round, round: cp.round, withEvidence: Boolean(executionCheckpoint) })
      : am?.(prompt, record.am_conversation_id, { responseContentType: "text/markdown", exposeText: false, correlationId: executionId, withEvidence: Boolean(executionCheckpoint) }) });
    if (!turn.result) return { handoff_id: handoffId, phase: "plan_critique", status: "paused", reason: turn.record.critique_checkpoint.error_code, checkpoint: turn.record.critique_checkpoint };
    if (step === "am") {
      const applied = await maybeApplyCritiqueRevision({ rawAmReply: turn.result.text, currentPlan: { plan_id: record.plan_id, revision: record.plan_revision, sha256: record.plan_sha256, source_path: record.plan_source_path }, currentPlanJson: planJson, conversationId: record.am_conversation_id });
      await critique.advance(handoffId, { round: cp.round, history: [...(record.history ?? []), { phase: "plan_critique", critique_round: cp.round, am_reply: applied.cleanReply, timestamp: new Date().toISOString() }], plan: applied.currentPlan });
    }
    const latest = await store.get(handoffId);
    return { handoff_id: handoffId, phase: latest.phase, status: latest.status, reason: latest.critique_checkpoint?.error_code ?? null, checkpoint: latest.critique_checkpoint };
  }

  // Business purpose: runs Phase 1 (1-2 rounds of AM-SE plan critique) and Phase 2 automatic handoff to SL or SE.
  // Technical description: publishes the human-readable brief, coordinates 1-2 rounds of AM-SE critique, auto-approves the unified revision, and dispatches either SL sprint generation or SE multi-round implementation and AM acceptance review.
  async function startHandoff({
    plan, planJson: suppliedPlanJson, intake = {}, deliveryTarget = "se", conversationId, approvedOwnerId = "project-owner",
    approvePlan: turnApprovePlan = approvePlan, requestArchitecture: turnRequestArchitecture = requestArchitecture,
    requestSystemEngineer: turnRequestSystemEngineer = requestSystemEngineer, requestReviewer: turnRequestReviewer = requestReviewer
  } = {}) {
    const target = (deliveryTarget || intake.delivery_target) === "sl" ? "sl" : "se";
    const seProfile = agentRoleResolver ? agentRoleResolver.resolveProfile("system_engineer") : { agent_id: "system-engineer", role: "system_engineer" };
    if (!seProfile?.agent_id) throw Object.assign(new ConfigurationError("No enabled System Engineer agent is available for automatic handoff."), { code: "SYSTEM_ENGINEER_UNAVAILABLE", statusCode: 409 });
    const amProfile = agentRoleResolver?.resolveProfile?.("architecture_manager") ?? { agent_id: "architecture-manager", role: "architecture_manager" };
    const rvProfile = agentRoleResolver?.resolveProfile?.("reviewer") ?? { agent_id: "reviewer", role: "reviewer" };

    let currentPlan = { plan_id: plan.plan_id, revision: plan.revision, sha256: plan.sha256, source_path: plan.source_path };
    let currentPlanJson = suppliedPlanJson ?? parseArchitecturePlanJSON(await fileService.readFile({ path: currentPlan.source_path }));
    const seConversationId = `CONV-SE-${currentPlan.plan_id}`;
    const rvConversationId = `CONV-RV-${currentPlan.plan_id}`;
    // Keep the provider session isolated internally; publish its dialogue only in the source conversation.

    let record = await store.create({
      handoffId: `HANDOFF-${currentPlan.plan_id}-R${currentPlan.revision}`, planId: currentPlan.plan_id, planRevision: currentPlan.revision, planSha256: currentPlan.sha256,
      planSourcePath: currentPlan.source_path, deliveryTarget: target, sourceKind: intake.source_kind ?? "conversation", sourceFilePath: intake.source_file_path ?? null,
      workspaceScopePaths: intake.workspace_scope_paths,
      amAgentId: amProfile.agent_id, seAgentId: seProfile.agent_id, rvAgentId: rvProfile.agent_id, amConversationId: conversationId, seConversationId, rvConversationId,
      phase: "plan_critique", status: "critiquing", maxCritiqueRounds, maxRounds
    });

    const brief = formatHumanReadableHandoffBrief(currentPlanJson, {
      planId: currentPlan.plan_id, revision: currentPlan.revision, sourceKind: record.source_kind, sourceFilePath: record.source_file_path, planSourcePath: currentPlan.source_path, deliveryTarget: target
    });
    const correlationBase = `CORR-HANDOFF-${currentPlan.plan_id}`;
    publishDualConversationMessage({
      sender: { id: amProfile.agent_id, role: "architecture_manager" }, recipient: { id: seProfile.agent_id, role: "system_engineer" },
      messageType: "architecture.message.received", amConversationId: conversationId, seConversationId, correlationId: `${correlationBase}-BRIEF`,
      text: brief, extraPayload: { handoff_id: record.handoff_id, plan_id: currentPlan.plan_id, phase: "plan_critique" }
    });

    await critique.initialize(record.handoff_id);
    const history = [];
    let critiqueRound = 1;
    if (typeof turnRequestSystemEngineer === "function") {
      let critiquePrompt = `${brief}\n\n[Giai đoạn 1 - Phản biện kế hoạch (Vòng 1/${record.max_critique_rounds})]: Hãy khảo sát nhanh các file liên quan bằng công cụ đọc/tìm kiếm (chưa sửa file) và cho ý kiến phản biện kỹ thuật về bản kế hoạch trên. Kết thúc bằng [CRITIQUE: ALIGNED] hoặc [CRITIQUE: DISCUSS].`;
      for (critiqueRound = 1; critiqueRound <= record.max_critique_rounds; critiqueRound += 1) {
        const seTurn = await critique.run(record.handoff_id, { step: "se", round: critiqueRound, invoke: (executionId) => turnRequestSystemEngineer({
          agentId: seProfile.agent_id, prompt: critiquePrompt, conversationId: seConversationId, linkedConversationId: conversationId,
          correlationId: executionId, phase: "plan_critique", critiqueRound, round: critiqueRound, withEvidence: Boolean(executionCheckpoint)
        }) });
        record = seTurn.record;
        if (!seTurn.result) return { handoff_id: record.handoff_id, phase: "plan_critique", status: "paused", reason: record.critique_checkpoint.error_code };
        const rawSeCritique = seTurn.result.text;
        const { status: critiqueStatus, cleanText: seCritiqueText } = parseSePlanCritique(rawSeCritique);
        publishDualConversationMessage({
          sender: { id: seProfile.agent_id, role: "system_engineer" }, recipient: { id: amProfile.agent_id, role: "architecture_manager" },
          messageType: "system_engineer.message.received", amConversationId: conversationId, seConversationId, correlationId: `${correlationBase}-CRITIQUE-SE-R${critiqueRound}`,
          text: seCritiqueText, extraPayload: { handoff_id: record.handoff_id, phase: "plan_critique", critique_round: critiqueRound, critique_status: critiqueStatus }
        });

        if (critiqueStatus === "ALIGNED" || critiqueRound >= record.max_critique_rounds) {
          history.push({ phase: "plan_critique", critique_round: critiqueRound, se_critique: seCritiqueText, critique_status: critiqueStatus, timestamp: new Date().toISOString() });
          record = await store.transition(record.handoff_id, record.critique_checkpoint.generation, (current) => ({ ...current, history, critique_round: critiqueRound, critique_checkpoint: { ...current.critique_checkpoint, next_step: null, execution_status: "completed" } }));
          break;
        }

        const amTurn = await critique.run(record.handoff_id, { step: "am", round: critiqueRound, invoke: (executionId) => typeof turnRequestArchitecture === "function"
          ? turnRequestArchitecture(buildAmCritiqueReplyPrompt({ planJson: currentPlanJson, planId: currentPlan.plan_id, seCritiqueText }), conversationId, { responseContentType: "text/markdown", exposeText: false, correlationId: executionId, withEvidence: Boolean(executionCheckpoint) })
          : "Architecture Manager đã ghi nhận và làm rõ các điểm phản biện của SE." });
        record = amTurn.record;
        if (!amTurn.result) return { handoff_id: record.handoff_id, phase: "plan_critique", status: "paused", reason: record.critique_checkpoint.error_code };
        const rawAmReply = amTurn.result.text;
        const applied = await maybeApplyCritiqueRevision({ rawAmReply, currentPlan, currentPlanJson, conversationId });
        currentPlan = applied.currentPlan;
        currentPlanJson = applied.currentPlanJson;
        history.push({ phase: "plan_critique", critique_round: critiqueRound, se_critique: seCritiqueText, am_reply: applied.cleanReply, critique_status: critiqueStatus, plan_revision: currentPlan.revision, timestamp: new Date().toISOString() });
        record = await critique.advance(record.handoff_id, { round: critiqueRound, history, plan: currentPlan });
        publishDualConversationMessage({
          sender: { id: amProfile.agent_id, role: "architecture_manager" }, recipient: { id: seProfile.agent_id, role: "system_engineer" },
          messageType: "architecture.message.received", amConversationId: conversationId, seConversationId, correlationId: `${correlationBase}-CRITIQUE-AM-R${critiqueRound}`,
          text: applied.cleanReply, extraPayload: { handoff_id: record.handoff_id, phase: "plan_critique", critique_round: critiqueRound, plan_revision: currentPlan.revision }
        });
        critiquePrompt = `### Phản hồi làm rõ kế hoạch từ Architecture Manager (Vòng ${critiqueRound + 1}/${record.max_critique_rounds} - ${currentPlan.plan_id} r${currentPlan.revision})\n\n${applied.cleanReply}\n\nVui lòng xác nhận phương án đã thống nhất và kết thúc bằng [CRITIQUE: ALIGNED].`;
      }
    }

    let approvedPlan;
    try {
      approvedPlan = await markdownPlanStore.assertApproved({ planId: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256 });
      if (!approvedOwnerId || approvedPlan.decision?.approver_id !== approvedOwnerId) throw new ConfigurationError("Authenticated Owner approval is required.");
    } catch (error) {
      void error;
      record = await store.update(record.handoff_id, { phase: "plan_critique", status: "paused", plan_revision: currentPlan.revision, plan_sha256: currentPlan.sha256, plan_source_path: currentPlan.source_path, critique_round: critiqueRound, history });
      return { handoff_id: record.handoff_id, phase: "plan_critique", status: "paused", reason: "PLAN_APPROVAL_REQUIRED", plan_id: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256, history };
    }
    const consensusText = `### Chốt thống nhất kế hoạch giữa AM & SE: ${currentPlan.plan_id} (r${currentPlan.revision})\nArchitecture Manager và System Engineer đã hoàn tất ${critiqueRound} vòng phản biện kỹ thuật. Kế hoạch **${currentPlan.plan_id} r${currentPlan.revision}** có approval hợp lệ trước khi chuyển sang giai đoạn thực thi (**${target.toUpperCase()}**).`;
    publishDualConversationMessage({
      sender: { id: amProfile.agent_id, role: "architecture_manager" }, recipient: { id: seProfile.agent_id, role: "system_engineer" },
      messageType: "architecture.message.received", amConversationId: conversationId, seConversationId, correlationId: `${correlationBase}-CONSENSUS`,
      text: consensusText, extraPayload: { handoff_id: record.handoff_id, phase: "plan_critique", plan_revision: currentPlan.revision }
    });

    if (target === "sl") {
      record = await store.update(record.handoff_id, { phase: "sl_handoff", status: "running", plan_revision: currentPlan.revision, plan_sha256: currentPlan.sha256, plan_source_path: currentPlan.source_path, critique_round: critiqueRound, history });
      const approved = await turnApprovePlan({ planId: currentPlan.plan_id, conversationId, approvedOwnerId: approvedOwnerId || "project-owner", approvalRevision: currentPlan.revision, approvalSha256: currentPlan.sha256 });
      record = await store.update(record.handoff_id, { phase: "sl_handoff", status: "completed", history });
      const slDoneText = `Đã hoàn tất bàn giao kế hoạch **${currentPlan.plan_id} r${currentPlan.revision}** (sau khi AM & SE phản biện thống nhất) cho **Sprint Leader (SL)**. Sprint **${approved.sprint_id}** đã được tạo ở trạng thái **${approved.sprint_status ?? "ready"}**.`;
      publishDualConversationMessage({
        sender: { id: amProfile.agent_id, role: "architecture_manager" }, recipient: { id: seProfile.agent_id, role: "system_engineer" },
        messageType: "architecture.message.received", amConversationId: conversationId, seConversationId, correlationId: `${correlationBase}-SL-DONE`,
        text: slDoneText, extraPayload: { handoff_id: record.handoff_id, phase: "sl_handoff", sprint_id: approved.sprint_id }
      });
      return { ...approved, handoff_id: record.handoff_id, phase: "sl_handoff", delivery_target: "sl", plan_id: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256, se_conversation_id: seConversationId, critique_rounds_completed: critiqueRound, brief, history };
    }

    record = await store.update(record.handoff_id, { phase: "implementation", status: "running", round: 1, plan_revision: currentPlan.revision, plan_sha256: currentPlan.sha256, plan_source_path: currentPlan.source_path, critique_round: critiqueRound, history });
    if (checkpoint) {
      record = await checkpoint.initialize(record.handoff_id, approvedOwnerId);
      return resumeHandoff({ handoffId: record.handoff_id, approvedOwnerId, requestArchitecture: turnRequestArchitecture, requestSystemEngineer: turnRequestSystemEngineer, requestReviewer: turnRequestReviewer, drain: true });
    }
    record = await store.update(record.handoff_id, { status: "paused" });
    return { handoff_id: record.handoff_id, phase: "implementation", status: "paused", reason: "HANDOFF_CHECKPOINT_UNAVAILABLE", plan_id: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256, history };
  }

  // Business purpose: projects every persisted handoff role and checkpoint result for Owner recovery controls.
  // Technical description: returns redacted state-machine evidence for AM, SE and RV without exposing prompts, workspace bytes or credentials.
  async function listHandoffs() {
    const records = typeof store.list === "function" ? await store.list() : [];
    const indexedPlanIds = new Set((markdownPlanStore?.list?.() ?? []).map((plan) => plan.plan_id));
    return records.filter((record) => indexedPlanIds.has(record.plan_id)).map((record) => ({
      handoff_id: record.handoff_id, plan_id: record.plan_id, plan_revision: record.plan_revision, plan_sha256: record.plan_sha256,
      phase: record.phase, status: record.status, round: record.round, max_rounds: record.max_rounds,
      critique_checkpoint: record.critique_checkpoint ? {
        round: record.critique_checkpoint.round, current_step: record.critique_checkpoint.current_step,
        next_step: record.critique_checkpoint.next_step, execution_status: record.critique_checkpoint.execution_status,
        attempt: record.critique_checkpoint.attempt, error_code: record.critique_checkpoint.execution_status === "pending" ? null : record.critique_checkpoint.error_code,
        results: (record.critique_checkpoint.results ?? []).map((item) => ({ step: item.step, round: item.round, execution_id: item.execution_id, completed_at: item.completed_at, text: item.text }))
      } : null,
      approval_required: record.delivery_target === "se" && record.phase === "plan_critique" && record.status === "paused" && !record.checkpoint && record.history?.at(-1)?.critique_status === "ALIGNED",
      critique_round: record.critique_round, delivery_target: record.delivery_target, updated_at: record.updated_at,
      roles: { am: { agent_id: record.am_agent_id, conversation_id: record.am_conversation_id }, se: { agent_id: record.se_agent_id, conversation_id: record.se_conversation_id }, rv: { agent_id: record.rv_agent_id, conversation_id: record.rv_conversation_id } },
      can_resume: Boolean(record.checkpoint && record.checkpoint.execution_status === "pending") || Boolean(record.critique_checkpoint && ["pending", "unknown"].includes(record.critique_checkpoint.execution_status)) || Boolean(!record.checkpoint && record.phase === "plan_critique" && record.status === "paused" && record.history?.at(-1)?.critique_status === "ALIGNED"),
      can_reconcile: Boolean(record.checkpoint && ["running", "reconciliation_required", "unknown"].includes(record.checkpoint.execution_status)),
      critique_can_resume: Boolean(record.critique_checkpoint && ["pending", "unknown"].includes(record.critique_checkpoint.execution_status)),
      critique_can_pause: false,
      can_pause: Boolean(record.checkpoint && record.checkpoint.execution_status === "running"),
      checkpoint: record.checkpoint ? {
        generation: record.checkpoint.generation, round: record.checkpoint.round, current_step: record.checkpoint.current_step,
        next_step: record.checkpoint.next_step, execution_status: record.checkpoint.execution_status, execution_id: record.checkpoint.execution_id,
        attempt: record.checkpoint.attempt, error_code: record.checkpoint.execution_status === "pending" ? null : record.checkpoint.error_code, updated_at: record.checkpoint.updated_at,
        results: (record.checkpoint.results ?? []).map((result) => ({ round: result.round, step: result.step, execution_id: result.execution_id, attempt: result.attempt, verdict: result.verdict, completed_at: result.completed_at, text: result.text, result_evidence: result.result_evidence, read_only_enforced: result.read_only_enforced }))
      } : null
    }));
  }

  // Business purpose: expose guarded reconciliation only to the exact Owner and approved plan revision.
  // Technical description: verifies persisted handoff identity and approval before assessing runner stop evidence; it never retries an uncertain execution automatically.
  async function pauseHandoff({ handoffId, approvedOwnerId, expectedRevision, expectedSha256 } = {}) {
    if (!checkpoint?.pause) throw Object.assign(new ConfigurationError("Handoff pause is unavailable."), { code: "HANDOFF_PAUSE_UNAVAILABLE", statusCode: 409 });
    const record = await store.get(handoffId);
    if (!record || record.project_id !== projectId || record.delivery_target !== "se" || !approvedOwnerId || expectedRevision !== record.plan_revision || expectedSha256 !== record.plan_sha256) throw Object.assign(new ConfigurationError("Handoff identity is unavailable."), { code: "HANDOFF_IDENTITY_INVALID", statusCode: 409 });
    const checkpointOwner = record.checkpoint?.approved_owner_id;
    if (!checkpointOwner || checkpointOwner !== approvedOwnerId) throw Object.assign(new ConfigurationError("Owner approval does not match the checkpoint."), { code: "PLAN_APPROVAL_OWNER_MISMATCH", statusCode: 409 });
    await checkpoint.verifyPlan(record);
    return checkpoint.pause(handoffId, { record });
  }

  // Business purpose: gives the Owner a safe explanation of workspace drift and a guarded baseline reset option.
  // Technical description: delegates diagnostics and exact-approval adoption to the handoff checkpoint without editing project files.
  async function handoffWorkspaceStatus({ handoffId } = {}) {
    if (!checkpoint) throw Object.assign(new ConfigurationError("Handoff checkpoint is unavailable."), { code: "HANDOFF_CHECKPOINT_UNAVAILABLE", statusCode: 503 });
    return checkpoint.workspaceStatus(handoffId);
  }

  // Business purpose: lets the exact approving Owner re-pin a pristine first SE handoff to the present workspace.
  // Technical description: requires a stopped, tool-free prior attempt and updates only the locked checkpoint baseline.
  async function adoptHandoffWorkspace({ handoffId, approvedOwnerId, expectedRevision, expectedSha256 } = {}) {
    if (!checkpoint) throw Object.assign(new ConfigurationError("Handoff checkpoint is unavailable."), { code: "HANDOFF_CHECKPOINT_UNAVAILABLE", statusCode: 503 });
    return checkpoint.adoptWorkspace(handoffId, { approvedOwnerId, expectedRevision, expectedSha256 });
  }

  async function reconcileHandoff({ handoffId, approvedOwnerId, expectedRevision, expectedSha256, operatorApproved = false } = {}) {
    if (!checkpoint) throw Object.assign(new ConfigurationError("Handoff checkpoint is unavailable."), { code: "HANDOFF_CHECKPOINT_UNAVAILABLE", statusCode: 503 });
    const record = await store.get(handoffId);
    if (!record || record.project_id !== projectId || record.delivery_target !== "se" || !approvedOwnerId || expectedRevision !== record.plan_revision || expectedSha256 !== record.plan_sha256) throw Object.assign(new ConfigurationError("Handoff identity is unavailable."), { code: "HANDOFF_IDENTITY_INVALID", statusCode: 409 });
    const approved = await checkpoint.verifyPlan(record);
    if (approved.decision?.approver_id !== approvedOwnerId) throw Object.assign(new ConfigurationError("Owner approval does not match."), { code: "PLAN_APPROVAL_OWNER_MISMATCH", statusCode: 409 });
    return checkpoint.reconcile(handoffId, { operatorApproved });
  }

  return Object.freeze({ startHandoff, resumeHandoff, resumeCritique, pauseHandoff, reconcileHandoff, handoffWorkspaceStatus, adoptHandoffWorkspace, listHandoffs, store, critique, formatHumanReadableHandoffBrief, parseSePlanCritique, parseAmReviewVerdict, parseRvReviewVerdict });
}
