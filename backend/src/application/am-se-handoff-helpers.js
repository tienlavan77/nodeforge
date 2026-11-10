// Business purpose: provides prompt construction, critique/verdict parsing, and Owner projection helpers for the AM <-> SE <-> RV handoff orchestration service.
// Technical description: formats human-readable handoff briefs, parses [CRITIQUE: ALIGNED|DISCUSS] and [VERDICT: PASS|REVISE] markers, applies RFC 7396 critique patches, and projects persisted handoff records.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { appendArchitectureDecisions, readArchitectureDecisions } from "../modules/governance/architecture-owner-decisions.js";
import { architectureSessionFromRecord, canonicalArchitecturePlanSha256, canonicalizeArchitecturePlanJSON, mergeArchitecturePlanJSON, renderArchitecturePlanMarkdown } from "../modules/governance/architecture-plan-json.js";
import { retainConversationPlanSource } from "../modules/governance/conversation-plan-source.js";

// Business purpose: formats an Architecture Plan JSON object into a clear, natural-language Markdown brief so human readers and the System Engineer can review and critique the plan without reading raw JSON dumps.
// Technical description: renders the plan title, metadata, delivery target (SL or SE), objective, background, itemized outcomes with acceptance criteria and guardrails, evidence references, verification instructions, a critique invitation, and the canonical JSON source path.
export function formatHumanReadableHandoffBrief(planJson, { planId, revision = 1, sourceKind = "conversation", sourceFilePath = null, planSourcePath = null, deliveryTarget = "se" } = {}) {
  const sourceLabel = sourceKind === "markdown_file" && sourceFilePath ? `từ tài liệu đặc tả \`${sourceFilePath}\`` : "từ cuộc trao đổi kiến trúc";
  const targetLabel = deliveryTarget === "sl" ? "Sprint Leader (SL)" : "System Engineer (SE)";
  const outcomes = (planJson?.outcomes ?? []).map((item) => [`### Hạng mục ${item.id}: ${item.outcome}`, ...(item.acceptance_criteria ?? []).map((ac) => `  - Tiêu chí hoàn thành: ${ac}`), ...(item.guardrails ?? []).map((gr) => `  - Ranh giới & lưu ý: ${gr}`)].join("\n")).join("\n\n");
  const evidenceList = Array.isArray(planJson?.evidence) && planJson.evidence.length ? planJson.evidence.map((ev) => `- \`${ev.path}\`${ev.location ? ` (${ev.location})` : ""}: ${ev.fact}`).join("\n") : "- Xem trong hồ sơ kế hoạch gốc.";
  const scopeList = Array.isArray(planJson?.scope) && planJson.scope.length ? planJson.scope.map((s) => `- ${s}`).join("\n") : "";
  return [
    `## Trình bày & Phản biện kế hoạch kiến trúc (Đích giao việc: ${targetLabel}): ${planJson?.title ?? planId}`, "",
    `Architecture Manager (người viết kế hoạch) đã hoàn tất bản dự thảo **${planId} (r${revision})** ${sourceLabel}, dự kiến bàn giao thực thi cho **${targetLabel}**.`, "",
    "### 1. Mục tiêu tổng thể", planJson?.objective ?? "", ...(planJson?.background ? ["", "**Bối cảnh:**", planJson.background] : []),
    ...(scopeList ? ["", "### 2. Phạm vi thực hiện", scopeList] : []), "", "### 3. Các hạng mục công việc & Tiêu chí nghiệm thu", outcomes, "",
    "### 4. Khu vực mã nguồn tham chiếu & Kiểm thử xác nhận", "**Mã nguồn liên quan:**", evidenceList, "",
    `**Phương thức kiểm thử & nghiệm thu:** ${planJson?.verification ?? "Chạy kiểm thử đơn vị và kiểm tra tĩnh cho các file thay đổi."}`, "",
    "### 5. Mời System Engineer phản biện kế hoạch",
    "Mời **System Engineer (SE)** khảo sát nhanh các file mã nguồn liên quan và cho ý kiến phản biện kỹ thuật (tính khả thi, điểm xung đột với code hiện tại, rủi ro hoặc đề xuất cải thiện cấu trúc `outcomes`/`guardrails`) trước khi chốt phương án giao việc. Kết thúc phản hồi bằng `[CRITIQUE: ALIGNED]` nếu đã đồng thuận hoặc `[CRITIQUE: DISCUSS]` nếu cần điều chỉnh.",
    ...(planSourcePath ? ["", `Hồ sơ kế hoạch gốc: \`${planSourcePath}\``] : [])
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

// Business purpose: extracts the independent Reviewer's verdict ([VERDICT: PASS] or [VERDICT: REVISE]) and cleaned review findings during an AM-SE-RV execution cycle.
// Technical description: delegates to parseAmReviewVerdict so RV and AM share the same deterministic [VERDICT: PASS|REVISE] parsing contract.
export function parseRvReviewVerdict(rawText) {
  return parseAmReviewVerdict(rawText);
}

// Business purpose: builds the prompt asking the Architecture Manager to respond to the System Engineer's Round 1 plan critique and optionally emit an RFC 7396 JSON merge patch if the plan needs adjustment to r2.
// Technical description: combines the canonical plan JSON and the System Engineer's critique remarks, instructing AM to answer in natural language and optionally include a fenced json merge patch block.
export function buildAmCritiqueReplyPrompt({ planJson, planId, seCritiqueText }) {
  return [
    `Architecture plan critique response (${planId}, round 1).`,
    "System Engineer reviewed your plan and raised points for discussion.",
    "Reply in clear, natural language addressing each point so the Project Owner and System Engineer can follow the discussion.",
    "If you agree to adjust the plan, include at most one ```json ... ``` RFC 7396 merge patch block at the end of your reply; Node will update the current unapproved r1 in place, never create r2 during critique.",
    "", "Current canonical plan:", JSON.stringify(planJson), "",
    "System Engineer critique:", String(seCritiqueText ?? "")
  ].join("\n");
}

// Business purpose: builds the prompt asking the independent Reviewer (RV) to inspect the System Engineer's code changes in read-only mode before Architecture Manager acceptance.
// Technical description: combines the canonical plan outcomes/guardrails, current round number, and SE's implementation report, instructing RV to verify changed files and conventions (250 lines for .md, 400 code_lines for code) using read-only tools and end with [VERDICT: PASS] or [VERDICT: REVISE].
export function buildRvImplementationReviewPrompt({ planJson, planId, round, maxRounds, seReplyText, workspace }) {
  const outcomesSummary = (planJson?.outcomes ?? []).map((o) => `- ${o.id} (${o.outcome}): Tiêu chí: ${(o.acceptance_criteria ?? []).join("; ")} | Guardrails: ${(o.guardrails ?? []).join("; ")}`).join("\n");
  const workspaceMeta = workspace ? `Pinned handoff workspace metadata: head_sha=${workspace.head_sha ?? "HEAD"}, scope_paths=${JSON.stringify(workspace.scope_paths ?? [])}` : "";
  return [
    `Independent Reviewer (RV) verification for System Engineer implementation (${planId}, round ${round}/${maxRounds}).`,
    "Operate strictly in read-only mode: call read_subagent_evidence({}) first to reuse shared AM/SE file metadata and sha256 checksums, then use your read-only Forge tools (read_file, Read, search_text, list_files, search_tree, git_status, git_diff, git_log, git_show, git_blame, git_branch) to inspect the System Engineer's changes against the plan outcomes, guardrails, test evidence, and repository conventions (at most 250 lines for .md files and 400 code_lines for code files). Use git_show({revision, path}), git_diff({base, head, paths}), and git_status({paths}) to inspect exact committed revisions without being blocked by unrelated working-tree files. Never modify files.",
    workspaceMeta,
    "Write a clear, constructive review in natural language:",
    "1. Summarize verified implementation evidence and test coverage.",
    "2. List any defects, missing acceptance criteria, or guardrail violations with exact file paths and actionable repair instructions for SE.",
    "3. On the final line of your response, append exactly [VERDICT: PASS] if the implementation is ready for Architecture Manager acceptance, or [VERDICT: REVISE] if SE must fix issues first.",
    "", "Plan outcomes, acceptance criteria, and guardrails:", outcomesSummary, "",
    `System Engineer round ${round} report:`, String(seReplyText ?? "(No text returned)")
  ].filter(Boolean).join("\n");
}

// Business purpose: builds the prompt asking the Architecture Manager to perform final acceptance review after SE implementation and RV verification.
// Technical description: combines plan outcomes, SE report, and RV review text into a structured review prompt ending with [VERDICT: PASS|REVISE].
export function buildAmAcceptanceReviewPrompt({ planJson, planId, round, maxRounds, seReplyText, rvReviewText = "" }) {
  const outcomesSummary = (planJson?.outcomes ?? []).map((o) => `- ${o.id} (${o.outcome}): Tiêu chí: ${(o.acceptance_criteria ?? []).join("; ")}`).join("\n");
  return [
    `Architecture acceptance review for System Engineer handoff (${planId}, round ${round}/${maxRounds}).`,
    "Use your read-only Forge tools (read_subagent_evidence, read_file, Read, search_text, git_status, git_diff) if needed to verify the System Engineer's implementation and the Reviewer's independent verification against every outcome and acceptance criterion below.",
    "Write your review in clear, natural language for the human Project Owner and System Engineer:",
    "1. Summarize the overall progress of this round.",
    "2. List each outcome (O1, O2, ...), clearly marking what is completed and what still needs adjustment (with specific file/behavior guidance if anything is incomplete).",
    "3. On the final line of your response, append exactly [VERDICT: PASS] if all acceptance criteria are satisfied, or [VERDICT: REVISE] if another revision round is required.",
    "", "Plan outcomes and acceptance criteria:", outcomesSummary, "",
    `System Engineer round ${round} report:`, String(seReplyText ?? "(No text returned)"),
    ...(rvReviewText ? ["", `Independent Reviewer (RV) round ${round} assessment ([VERDICT: PASS]):`, String(rvReviewText)] : [])
  ].join("\n");
}

// Business purpose: publishes a communication message to the Architecture conversation with linked_conversation_id pointing to the SE conversation.
// Technical description: sends a message on the shared bus for amConversationId when bus.send is available.
export function publishDualHandoffMessage({ bus, projectId, sender, recipient, messageType, amConversationId, seConversationId, correlationId, text, extraPayload = {} }) {
  if (typeof bus?.send !== "function" || !amConversationId) return;
  const timestamp = new Date().toISOString();
  const basePayload = { text, content_type: "text/markdown", agent_status: "COMPLETED", ...extraPayload };
  bus.send({ id: `MSG-HANDOFF-AM-${randomUUID()}`, project_id: projectId, sender, recipient, message_type: messageType, conversation_id: amConversationId, correlation_id: correlationId, payload: { ...basePayload, linked_conversation_id: seConversationId ?? null }, timestamp });
}

// Business purpose: applies an optional RFC 7396 JSON merge patch emitted by AM during plan critique so agreed improvements update draft r1 before approval.
// Technical description: extracts a fenced json block from AM's critique response, merges and validates the updated plan, and persists the updated draft revision.
export async function applyCritiqueDraftRevision({ fileService, markdownPlanStore, rawAmReply, currentPlan, currentPlanJson, conversationId }) {
  const fenceMatch = /```json\s*([\s\S]*?)```/i.exec(rawAmReply);
  const cleanReply = rawAmReply.replace(/```json\s*[\s\S]*?```/gi, "").trim() || rawAmReply.trim();
  if (!fenceMatch?.[1]?.trim()) return { cleanReply, currentPlan, currentPlanJson, error: null };
  if (currentPlan.revision !== 1 || typeof markdownPlanStore.updateDraftRevision !== "function") throw Object.assign(new ConfigurationError("Unapproved r1 draft update is unavailable."), { code: "PLAN_REVISION_UNAVAILABLE", statusCode: 409 });
  try {
    const merged = mergeArchitecturePlanJSON(canonicalizeArchitecturePlanJSON(currentPlanJson), fenceMatch[1].trim());
    const canonicalBytes = canonicalizeArchitecturePlanJSON(merged);
    const summaryPath = currentPlan.source_path;
    const summarySha256 = canonicalArchitecturePlanSha256(merged);
    const baseMarkdown = renderArchitecturePlanMarkdown({ plan: merged, planId: currentPlan.plan_id, revision: 1, sourceSha256: summarySha256 });
    const prev = await markdownPlanStore.getRevision({ planId: currentPlan.plan_id, revision: 1 });
    const record = readArchitectureDecisions(prev?.markdown ?? "");
    const decisionSession = record?.decisions?.length ? architectureSessionFromRecord(record) : { session_id: `${currentPlan.plan_id}-R1`, source_path: summaryPath, source_sha256: summarySha256, owner_id: null, confirmed_at: null, questions: [], selections: {}, notes: {} };
    const stored = await markdownPlanStore.updateDraftRevision({ planId: currentPlan.plan_id, revision: 1, markdown: appendArchitectureDecisions(baseMarkdown, decisionSession), summaryPath, summarySha256, summaryContent: canonicalBytes, conversationId });
    await retainConversationPlanSource({ fileService, planId: currentPlan.plan_id, revision: 1, canonicalBytes, overwriteUnapproved: true });
    return { cleanReply, currentPlan: { plan_id: stored.plan_id, revision: 1, sha256: stored.sha256, source_path: summaryPath }, currentPlanJson: merged, error: null };
  } catch (error) {
    const code = ["PLAN_REVISION_CONFLICT", "PLAN_DECISION_EXISTS", "PLAN_SOURCE_MISMATCH"].includes(error?.code) ? error.code : "PLAN_PATCH_INVALID";
    throw Object.assign(error, { code, statusCode: error.statusCode ?? 409 });
  }
}

// Business purpose: projects every persisted handoff role and checkpoint result for Owner recovery controls.
// Technical description: returns redacted state-machine evidence for AM, SE and RV without exposing prompts, workspace bytes or credentials.
export function projectHandoffRecord(record) {
  return {
    handoff_id: record.handoff_id, plan_id: record.plan_id, plan_revision: record.plan_revision, plan_sha256: record.plan_sha256,
    phase: record.phase, status: record.status, approval_mode: record.approval_mode ?? "manual_panel_approval", round: record.round, max_rounds: record.max_rounds,
    critique_checkpoint: record.critique_checkpoint ? {
      round: record.critique_checkpoint.round, current_step: record.critique_checkpoint.current_step,
      next_step: record.critique_checkpoint.next_step, execution_status: record.critique_checkpoint.execution_status,
      attempt: record.critique_checkpoint.attempt, error_code: record.critique_checkpoint.execution_status === "pending" ? null : record.critique_checkpoint.error_code,
      results: (record.critique_checkpoint.results ?? []).map((item) => ({ step: item.step, round: item.round, execution_id: item.execution_id, completed_at: item.completed_at, text: item.text }))
    } : null,
    approval_required: record.delivery_target === "se" && record.phase === "plan_critique" && record.status === "paused" && !record.checkpoint && record.history?.at(-1)?.critique_status === "ALIGNED",
    critique_round: record.critique_round, delivery_target: record.delivery_target, updated_at: record.updated_at,
    roles: { am: { agent_id: record.am_agent_id, conversation_id: record.am_conversation_id }, se: { agent_id: record.se_agent_id, conversation_id: record.se_conversation_id }, rv: { agent_id: record.rv_agent_id, conversation_id: record.rv_conversation_id } },
    can_resume: record.status === "paused" || Boolean(record.checkpoint && ["pending", "blocked", "unknown", "reconciliation_required"].includes(record.checkpoint.execution_status)) || Boolean(record.critique_checkpoint && ["pending", "unknown"].includes(record.critique_checkpoint.execution_status)),
    can_reconcile: Boolean(record.checkpoint && ["running", "reconciliation_required", "unknown"].includes(record.checkpoint.execution_status)),
    critique_can_resume: Boolean(record.critique_checkpoint && ["pending", "unknown"].includes(record.critique_checkpoint.execution_status)),
    critique_can_pause: false,
    can_pause: Boolean(record.checkpoint && record.checkpoint.execution_status === "running"),
    capabilities: {
      run: Boolean(["se", "sl"].includes(record.delivery_target) && record.phase === "plan_critique" && record.status === "paused" && !record.checkpoint),
      resume: record.status === "paused" || Boolean(record.checkpoint && ["pending", "blocked", "unknown", "reconciliation_required"].includes(record.checkpoint.execution_status)) || Boolean(record.critique_checkpoint && ["pending", "unknown"].includes(record.critique_checkpoint.execution_status)),
      stop: Boolean(record.checkpoint && record.checkpoint.execution_status === "running"),
      reconcile: Boolean(record.checkpoint && ["running", "reconciliation_required", "unknown"].includes(record.checkpoint.execution_status))
    },
    checkpoint: record.checkpoint ? {
      generation: record.checkpoint.generation, round: record.checkpoint.round, current_step: record.checkpoint.current_step,
      next_step: record.checkpoint.next_step, execution_status: record.checkpoint.execution_status, execution_id: record.checkpoint.execution_id,
      attempt: record.checkpoint.attempt, error_code: record.checkpoint.execution_status === "pending" ? null : record.checkpoint.error_code, updated_at: record.checkpoint.updated_at,
      results: (record.checkpoint.results ?? []).map((result) => ({ round: result.round, step: result.step, execution_id: result.execution_id, attempt: result.attempt, verdict: result.verdict, completed_at: result.completed_at, text: result.text, result_evidence: result.result_evidence, read_only_enforced: result.read_only_enforced }))
    } : null
  };
}
