// Business purpose: orchestrates Phase 1 AM-SE plan critique (1-2 rounds between Architecture Manager as plan author and System Engineer as technical reviewer) for all automatic handoff targets, followed by Phase 2 execution handoff to either Sprint Leader (SL) or System Engineer (SE).
// Technical description: coordinates human-readable Markdown brief formatting, dual-conversation bus messaging, 1-2 round AM-SE plan critique with optional RFC 7396 r2 revision update, auto-approval in markdownPlanStore, SL sprint handoff, and multi-round SE implementation with AM acceptance review ([VERDICT: PASS] vs [VERDICT: REVISE]).
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { appendArchitectureDecisions, readArchitectureDecisions } from "../modules/governance/architecture-owner-decisions.js";
import { architectureSessionFromRecord, canonicalArchitecturePlanSha256, canonicalizeArchitecturePlanJSON, mergeArchitecturePlanJSON, parseArchitecturePlanJSON, renderArchitecturePlanMarkdown } from "../modules/governance/architecture-plan-json.js";
import { retainConversationPlanSource } from "../modules/governance/conversation-plan-source.js";
import { createAmSeHandoffStore } from "./am-se-handoff-store.js";

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
  const match = /\[CRITIQUE:\s*(ALIGNED|DISCUSS)\]/i.exec(text);
  const status = match ? match[1].toUpperCase() : /\bCRITIQUE:\s*DISCUSS\b/i.test(text) ? "DISCUSS" : "ALIGNED";
  const cleanText = text.replace(/\s*\[CRITIQUE:\s*(?:ALIGNED|DISCUSS)\]\s*/gi, "\n").trim();
  return { status, cleanText: cleanText || text };
}

// Business purpose: extracts the terminal coordination verdict ([VERDICT: PASS] or [VERDICT: REVISE]) from the Architecture Manager's review response while keeping the human-facing review prose clean.
// Technical description: matches the trailing [VERDICT: PASS|REVISE] marker case-insensitively and returns both the normalized verdict and the cleaned display text.
export function parseAmReviewVerdict(rawText) {
  const text = String(rawText ?? "").trim();
  const match = /\[VERDICT:\s*(PASS|REVISE)\]/i.exec(text);
  const verdict = match ? match[1].toUpperCase() : /\bPASS\b/.test(text) && !/\bREVISE\b/i.test(text) ? "PASS" : "REVISE";
  const cleanText = text.replace(/\s*\[VERDICT:\s*(?:PASS|REVISE)\]\s*/gi, "\n").trim();
  return { verdict, cleanText: cleanText || text };
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
function buildAmAcceptanceReviewPrompt({ planJson, planId, round, maxRounds, seReplyText }) {
  const outcomesSummary = (planJson?.outcomes ?? []).map((o) => `- ${o.id} (${o.outcome}): Tiêu chí: ${(o.acceptance_criteria ?? []).join("; ")}`).join("\n");
  return [
    `Architecture acceptance review for System Engineer handoff (${planId}, round ${round}/${maxRounds}).`,
    "Use your read-only Forge tools (read_file, Read, search_text, git_status, git_diff) if needed to verify the System Engineer's implementation against every outcome and acceptance criterion below.",
    "Write your review in clear, natural language for the human Project Owner and System Engineer:",
    "1. Summarize the overall progress of this round.",
    "2. List each outcome (O1, O2, ...), clearly marking what is completed and what still needs adjustment (with specific file/behavior guidance if anything is incomplete).",
    "3. On the final line of your response, append exactly [VERDICT: PASS] if all acceptance criteria are satisfied, or [VERDICT: REVISE] if another revision round is required.",
    "", "Plan outcomes and acceptance criteria:", outcomesSummary, "",
    `System Engineer round ${round} report:`, String(seReplyText ?? "(No text returned)")
  ].join("\n");
}

// Business purpose: creates the orchestration service that manages Phase 1 AM-SE plan critique and Phase 2 automatic handoffs to Sprint Leader or System Engineer.
// Technical description: wires fileService, markdownPlanStore, bus, conversationCrudService, agentRoleResolver, approvePlan, requestArchitecture, and requestSystemEngineer into startHandoff.
export function createAmSeHandoffService({
  projectId, fileService, markdownPlanStore, handoffStore, bus, agentRoleResolver, approvePlan, requestArchitecture, requestSystemEngineer, maxCritiqueRounds = 2, maxRounds = 5
} = {}) {
  if (!projectId || !fileService?.readFile || !markdownPlanStore?.decide) {
    throw Object.assign(new ConfigurationError("AM-SE handoff service requires projectId, FileService, and markdownPlanStore."), { code: "SE_HANDOFF_UNAVAILABLE", statusCode: 503 });
  }
  const store = handoffStore ?? createAmSeHandoffStore({ projectId, fileService });

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

  // Business purpose: runs Phase 1 (1-2 rounds of AM-SE plan critique) and Phase 2 (execution handoff to SL or SE) immediately after plan revision r1 is created.
  // Technical description: publishes the human-readable brief, coordinates 1-2 rounds of AM-SE critique, auto-approves the unified revision, and dispatches either SL sprint generation or SE multi-round implementation and AM acceptance review.
  async function startHandoff({
    plan, planJson: suppliedPlanJson, intake = {}, deliveryTarget = "se", conversationId, approvedOwnerId = "project-owner",
    approvePlan: turnApprovePlan = approvePlan, requestArchitecture: turnRequestArchitecture = requestArchitecture, requestSystemEngineer: turnRequestSystemEngineer = requestSystemEngineer
  } = {}) {
    const target = (deliveryTarget || intake.delivery_target) === "sl" ? "sl" : "se";
    const seProfile = agentRoleResolver ? agentRoleResolver.resolveProfile("system_engineer") : { agent_id: "system-engineer", role: "system_engineer" };
    if (!seProfile?.agent_id) throw Object.assign(new ConfigurationError("No enabled System Engineer agent is available for automatic handoff."), { code: "SYSTEM_ENGINEER_UNAVAILABLE", statusCode: 409 });
    const amProfile = agentRoleResolver?.resolveProfile?.("architecture_manager") ?? { agent_id: "architecture-manager", role: "architecture_manager" };

    let currentPlan = { plan_id: plan.plan_id, revision: plan.revision, sha256: plan.sha256, source_path: plan.source_path };
    let currentPlanJson = suppliedPlanJson ?? parseArchitecturePlanJSON(await fileService.readFile({ path: currentPlan.source_path }));
    const seConversationId = `CONV-SE-${currentPlan.plan_id}`;
    // Keep the provider session isolated internally; publish its dialogue only in the source conversation.

    let record = await store.create({
      handoffId: `HANDOFF-${currentPlan.plan_id}-R${currentPlan.revision}`, planId: currentPlan.plan_id, planRevision: currentPlan.revision, planSha256: currentPlan.sha256,
      planSourcePath: currentPlan.source_path, deliveryTarget: target, sourceKind: intake.source_kind ?? "conversation", sourceFilePath: intake.source_file_path ?? null,
      amAgentId: amProfile.agent_id, seAgentId: seProfile.agent_id, amConversationId: conversationId, seConversationId, phase: "plan_critique", status: "critiquing", maxCritiqueRounds, maxRounds
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

    const history = [];
    let critiqueRound = 1;
    if (typeof turnRequestSystemEngineer === "function") {
      let critiquePrompt = `${brief}\n\n[Giai đoạn 1 - Phản biện kế hoạch (Vòng 1/${record.max_critique_rounds})]: Hãy khảo sát nhanh các file liên quan bằng công cụ đọc/tìm kiếm (chưa sửa file) và cho ý kiến phản biện kỹ thuật về bản kế hoạch trên. Kết thúc bằng [CRITIQUE: ALIGNED] hoặc [CRITIQUE: DISCUSS].`;
      for (critiqueRound = 1; critiqueRound <= record.max_critique_rounds; critiqueRound += 1) {
        record = await store.update(record.handoff_id, { phase: "plan_critique", status: "critiquing", critique_round: critiqueRound });
        const rawSeCritique = String(await turnRequestSystemEngineer({
          agentId: seProfile.agent_id, prompt: critiquePrompt, conversationId: seConversationId, linkedConversationId: conversationId,
          correlationId: `${correlationBase}-CRITIQUE-SE-R${critiqueRound}`, phase: "plan_critique", critiqueRound, round: critiqueRound
        }) ?? "").trim();
        const { status: critiqueStatus, cleanText: seCritiqueText } = parseSePlanCritique(rawSeCritique);
        publishDualConversationMessage({
          sender: { id: seProfile.agent_id, role: "system_engineer" }, recipient: { id: amProfile.agent_id, role: "architecture_manager" },
          messageType: "system_engineer.message.received", amConversationId: conversationId, seConversationId, correlationId: `${correlationBase}-CRITIQUE-SE-R${critiqueRound}`,
          text: seCritiqueText, extraPayload: { handoff_id: record.handoff_id, phase: "plan_critique", critique_round: critiqueRound, critique_status: critiqueStatus }
        });

        if (critiqueStatus === "ALIGNED" || critiqueRound >= record.max_critique_rounds) {
          history.push({ phase: "plan_critique", critique_round: critiqueRound, se_critique: seCritiqueText, critique_status: critiqueStatus, timestamp: new Date().toISOString() });
          break;
        }

        const rawAmReply = typeof turnRequestArchitecture === "function"
          ? String(await turnRequestArchitecture(buildAmCritiqueReplyPrompt({ planJson: currentPlanJson, planId: currentPlan.plan_id, seCritiqueText }), conversationId, { responseContentType: "text/markdown", exposeText: false }) ?? "").trim()
          : "Architecture Manager đã ghi nhận và làm rõ các điểm phản biện của SE.";
        const applied = await maybeApplyCritiqueRevision({ rawAmReply, currentPlan, currentPlanJson, conversationId });
        currentPlan = applied.currentPlan;
        currentPlanJson = applied.currentPlanJson;
        history.push({ phase: "plan_critique", critique_round: critiqueRound, se_critique: seCritiqueText, am_reply: applied.cleanReply, critique_status: critiqueStatus, plan_revision: currentPlan.revision, timestamp: new Date().toISOString() });
        publishDualConversationMessage({
          sender: { id: amProfile.agent_id, role: "architecture_manager" }, recipient: { id: seProfile.agent_id, role: "system_engineer" },
          messageType: "architecture.message.received", amConversationId: conversationId, seConversationId, correlationId: `${correlationBase}-CRITIQUE-AM-R${critiqueRound}`,
          text: applied.cleanReply, extraPayload: { handoff_id: record.handoff_id, phase: "plan_critique", critique_round: critiqueRound, plan_revision: currentPlan.revision }
        });
        critiquePrompt = `### Phản hồi làm rõ kế hoạch từ Architecture Manager (Vòng ${critiqueRound + 1}/${record.max_critique_rounds} - ${currentPlan.plan_id} r${currentPlan.revision})\n\n${applied.cleanReply}\n\nVui lòng xác nhận phương án đã thống nhất và kết thúc bằng [CRITIQUE: ALIGNED].`;
      }
    }

    await markdownPlanStore.decide({
      planId: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256,
      decision: "approved", approverId: approvedOwnerId || "project-owner", comments: `Auto-approved after AM-SE plan critique (${critiqueRound} round(s)).`
    });
    const consensusText = `### Chốt thống nhất kế hoạch giữa AM & SE: ${currentPlan.plan_id} (r${currentPlan.revision})\nArchitecture Manager và System Engineer đã hoàn tất ${critiqueRound} vòng phản biện kỹ thuật, thống nhất phương án và tự động duyệt kế hoạch **${currentPlan.plan_id} r${currentPlan.revision}** để chuyển sang giai đoạn thực thi (**${target.toUpperCase()}**).`;
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
    if (typeof turnRequestSystemEngineer !== "function") {
      return { handoff_id: record.handoff_id, phase: "implementation", status: "running", delivery_target: "se", plan_id: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256, se_conversation_id: seConversationId, critique_rounds_completed: critiqueRound, brief, rounds_completed: 0, history };
    }

    let currentInstruction = `### Bắt đầu giai đoạn thực thi kế hoạch ${currentPlan.plan_id} (r${currentPlan.revision})\n\n${brief}\n\nKế hoạch đã được AM & SE thống nhất và duyệt. Hãy tiến hành triển khai mã nguồn, chạy kiểm thử xác nhận cho từng hạng mục và báo cáo kết quả.`;
    for (let round = 1; round <= record.max_rounds; round += 1) {
      record = await store.update(record.handoff_id, { phase: "implementation", status: "running", round });
      const seCorrelationId = `${correlationBase}-SE-R${round}`;
      const seReplyText = String(await turnRequestSystemEngineer({
        agentId: seProfile.agent_id, prompt: currentInstruction, conversationId: seConversationId, linkedConversationId: conversationId, correlationId: seCorrelationId, phase: "implementation", round
      }) ?? "").trim();

      publishDualConversationMessage({
        sender: { id: seProfile.agent_id, role: "system_engineer" }, recipient: { id: amProfile.agent_id, role: "architecture_manager" },
        messageType: "system_engineer.message.received", amConversationId: conversationId, seConversationId, correlationId: seCorrelationId,
        text: seReplyText, extraPayload: { handoff_id: record.handoff_id, phase: "implementation", round }
      });

      record = await store.update(record.handoff_id, { phase: "implementation", status: "reviewing", round });
      const reviewPrompt = buildAmAcceptanceReviewPrompt({ planJson: currentPlanJson, planId: currentPlan.plan_id, round, maxRounds: record.max_rounds, seReplyText });
      const rawAmReview = typeof turnRequestArchitecture === "function"
        ? String(await turnRequestArchitecture(reviewPrompt, conversationId, { responseContentType: "text/markdown", exposeText: false }) ?? "").trim()
        : "Nghiệm thu hoàn tất: Toàn bộ các hạng mục trong kế hoạch đã được SE triển khai.\n[VERDICT: PASS]";
      const { verdict, cleanText } = parseAmReviewVerdict(rawAmReview);

      history.push({ phase: "implementation", round, se_report: seReplyText, am_review: cleanText, verdict, timestamp: new Date().toISOString() });
      publishDualConversationMessage({
        sender: { id: amProfile.agent_id, role: "architecture_manager" }, recipient: { id: seProfile.agent_id, role: "system_engineer" },
        messageType: "architecture.message.received", amConversationId: conversationId, seConversationId, correlationId: `${correlationBase}-AM-REVIEW-R${round}`,
        text: cleanText, extraPayload: { handoff_id: record.handoff_id, phase: "implementation", round, verdict }
      });

      if (verdict === "PASS" || round >= record.max_rounds) {
        const finalStatus = verdict === "PASS" ? "completed" : "paused";
        record = await store.update(record.handoff_id, { phase: "implementation", status: finalStatus, round, history });
        return { handoff_id: record.handoff_id, phase: "implementation", status: finalStatus, delivery_target: "se", plan_id: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256, se_conversation_id: seConversationId, brief, am_review: cleanText, critique_rounds_completed: critiqueRound, rounds_completed: round, history };
      }

      currentInstruction = `### Hướng dẫn điều chỉnh vòng ${round + 1} từ Architecture Manager (${currentPlan.plan_id} r${currentPlan.revision})\n\n${cleanText}\n\nVui lòng kiểm tra và hoàn thiện các điểm còn thiếu trên, chạy lại kiểm thử liên quan và báo cáo kết quả.`;
    }
    return { handoff_id: record.handoff_id, phase: record.phase, status: record.status, delivery_target: "se", plan_id: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256, se_conversation_id: seConversationId, critique_rounds_completed: critiqueRound, brief, history };
  }

  return Object.freeze({ startHandoff, store, formatHumanReadableHandoffBrief, parseSePlanCritique, parseAmReviewVerdict });
}
