// Business purpose: orchestrates the 2-phase Architecture Manager (AM) and System Engineer (SE) plan critique and automatic delivery handoff (to Sprint Leader SL or System Engineer SE with independent Reviewer RV verification).
// Technical description: renders a human-readable Markdown brief from the canonical Architecture Plan JSON, conducts 1-2 rounds of AM-SE plan critique, auto-approves the unified plan revision, and dispatches either SL sprint generation or SE multi-round implementation with RV verification and AM acceptance review.
import { ConfigurationError } from "../shared/errors.js";
import { parseArchitecturePlanJSON } from "../modules/governance/architecture-plan-json.js";
import { createAmSeHandoffStore } from "./am-se-handoff-store.js";
import { createAmSeHandoffCheckpoint, resolveSafeResumeState } from "./am-se-handoff-checkpoint.js";
import { createAmSeCritiqueCheckpoint } from "./am-se-critique-checkpoint.js";
import { resumeAmSeCritique } from "./am-se-critique-resume.js";
import { handoffWorkspaceSnapshot } from "./am-se-handoff-workspace.js";
import { createTicketDirectiveInbox, formatMidFlightDirectives } from "../modules/supervisor/ticket/ticket-directive-inbox.js";
import { formatHumanReadableHandoffBrief, parseSePlanCritique, parseAmReviewVerdict, parseRvReviewVerdict, buildAmCritiqueReplyPrompt, buildRvImplementationReviewPrompt, buildAmAcceptanceReviewPrompt, publishDualHandoffMessage, applyCritiqueDraftRevision, projectHandoffRecord } from "./am-se-handoff-helpers.js";

export { formatHumanReadableHandoffBrief, parseSePlanCritique, parseAmReviewVerdict, parseRvReviewVerdict };

// Business purpose: creates the orchestration service that manages Phase 1 AM-SE plan critique and Phase 2 automatic handoffs to Sprint Leader or System Engineer (with independent Reviewer RV verification).
// Technical description: wires fileService, markdownPlanStore, bus, conversationCrudService, agentRoleResolver, approvePlan, requestArchitecture, requestSystemEngineer, and requestReviewer into startHandoff.
export function createAmSeHandoffService({
  projectId, fileService, markdownPlanStore, bus, gitService, executionCheckpoint, pauseExecution,
  agentRoleResolver, approvePlan, requestArchitecture, requestSystemEngineer, requestReviewer,
  handoffStore, directiveInbox: injectedDirectiveInbox = null, maxCritiqueRounds = 2, maxRounds = 3
} = {}) {
  if (!fileService || !markdownPlanStore) throw new ConfigurationError("AM-SE handoff service requires fileService and markdownPlanStore.");
  const store = handoffStore ?? (projectId && fileService?.createLock && fileService?.atomicWrite ? createAmSeHandoffStore({ projectId, fileService }) : { create: async (r) => r, update: async (_id, p) => p });
  const checkpoint = projectId && store.transition ? createAmSeHandoffCheckpoint({ projectId, store, markdownPlanStore, fileService, gitService, executionCheckpoint, pauseExecution, maxRounds }) : null;
  const directiveInbox = projectId && fileService?.createLock ? createTicketDirectiveInbox({ projectId, projectRoot: projectId, fileService }) : null;
  const critique = projectId && store.transition ? createAmSeCritiqueCheckpoint({ projectId, store, fileService, gitService, executionCheckpoint, maxCritiqueRounds }) : { initialize: async (id) => store.get?.(id), run: async (id, { invoke }) => ({ record: await store.get?.(id), result: { text: await invoke(`CORR-CRITIQUE-${id}`) } }), advance: async (id, { round, history, plan }) => store.update(id, { critique_round: round, history, ...(plan ? { plan_revision: plan.revision, plan_sha256: plan.sha256, plan_source_path: plan.source_path } : {}) }) };
  const publishDualConversationMessage = (args) => publishDualHandoffMessage({ bus, projectId, ...args });
  const maybeApplyCritiqueRevision = (args) => applyCritiqueDraftRevision({ fileService, markdownPlanStore, ...args });
  const handoffResultPayload = (record) => ({ handoff_id: record.handoff_id, phase: record.phase, status: record.status, reason: record.checkpoint.error_code, delivery_target: record.delivery_target, plan_id: record.plan_id, revision: record.plan_revision, sha256: record.plan_sha256, se_conversation_id: record.se_conversation_id, critique_rounds_completed: record.critique_round, rounds_completed: record.checkpoint.round, history: record.history, checkpoint: record.checkpoint });

  // Business purpose: resumes a saved handoff from the next durable SE, RV, or AM step.
  // Technical description: checks exact Owner approval, invokes only the role selected by the checkpoint, and retains each result before advancing.
  async function resumeHandoff({ handoffId, approvedOwnerId, requestSystemEngineer: se = requestSystemEngineer, requestReviewer: rv = requestReviewer, requestArchitecture: am = requestArchitecture, expectedRevision, expectedSha256, runToCompletion = false } = {}) {
    if (!checkpoint) throw Object.assign(new ConfigurationError("Handoff checkpoint is unavailable."), { code: "HANDOFF_CHECKPOINT_UNAVAILABLE", statusCode: 503 });
    let record = await store.get(handoffId);
    if (!record || record.project_id !== projectId || record.delivery_target !== "se" || !approvedOwnerId || record.am_conversation_id == null) throw Object.assign(new ConfigurationError("Handoff identity is unavailable."), { code: "HANDOFF_IDENTITY_INVALID", statusCode: 409 });
    if (expectedRevision !== undefined && expectedRevision !== record.plan_revision || expectedSha256 !== undefined && expectedSha256 !== record.plan_sha256) throw Object.assign(new ConfigurationError("Plan identity changed."), { code: "HANDOFF_PLAN_MISMATCH", statusCode: 409 });
    if (!record.checkpoint && record.critique_checkpoint) return resumeCritique({ handoffId, approvedOwnerId, requestSystemEngineer: se, requestArchitecture: am, requestReviewer: rv });
    let approved;
    if (record.checkpoint && !record.checkpoint.approval_pending) {
      if (!record.checkpoint.approved_owner_id) throw Object.assign(new ConfigurationError("Checkpoint has no recorded Owner approval; re-approve the plan before resuming."), { code: "PLAN_APPROVAL_REQUIRED", statusCode: 409 });
      if (record.checkpoint.approved_owner_id !== approvedOwnerId) throw Object.assign(new ConfigurationError("Owner approval does not match the checkpoint owner."), { code: "PLAN_APPROVAL_OWNER_MISMATCH", statusCode: 409 });
      approved = { decision: { approver_id: approvedOwnerId } };
    } else {
      try { approved = await checkpoint.verifyPlan(record); } catch (error) {
        if (error?.code === "PLAN_APPROVAL_REQUIRED" && record.approval_mode === "explicit_owner_command" && typeof markdownPlanStore?.decide === "function") {
          await markdownPlanStore.decide({ planId: record.plan_id, revision: record.plan_revision, sha256: record.plan_sha256, decision: "approved", approverId: approvedOwnerId });
          approved = await checkpoint.verifyPlan(record);
        } else if (error?.code === "PLAN_APPROVAL_REQUIRED") throw Object.assign(new ConfigurationError("AM-SE handoff requires exact Owner approval before SE execution."), { code: "PLAN_APPROVAL_REQUIRED", statusCode: 409, cause: error });
        else throw error;
      }
    }
    if (approved.decision?.approver_id !== approvedOwnerId) throw Object.assign(new ConfigurationError("Owner approval does not match."), { code: "PLAN_APPROVAL_OWNER_MISMATCH", statusCode: 409 });
    if (!record.checkpoint) {
      if (record.phase !== "plan_critique" || record.status !== "paused" || record.history?.at(-1)?.critique_status !== "ALIGNED") throw Object.assign(new ConfigurationError("A saved critique result is required."), { code: "HANDOFF_CRITIQUE_REQUIRED", statusCode: 409 });
      record = await store.transition(handoffId, 0, (current) => ({ ...current, phase: "implementation", status: "running", round: 1, error_code: null, checkpoint: { generation: 0, approval_pending: true } }));
    }
    for (let attempt = 0; record.checkpoint?.approval_pending && attempt < 2; attempt += 1) {
      try { record = await checkpoint.initialize(handoffId, approvedOwnerId); } catch (error) { if (!["HANDOFF_STALE", "HANDOFF_INITIALIZATION_INVALID"].includes(error?.code) || attempt !== 0) throw error; const latest = await store.get(handoffId); if (!latest?.checkpoint || latest.checkpoint.approval_pending) throw error; record = latest; }
    }
    if (record.checkpoint?.approval_pending) throw Object.assign(new ConfigurationError("Handoff initialization is still in progress; refresh and retry."), { code: "HANDOFF_BUSY", statusCode: 409 });
    if (record.checkpoint && record.status !== "completed" && record.checkpoint.execution_status !== "completed") {
      const cp = record.checkpoint; const convId = cp.current_step === "se" ? record.se_conversation_id : cp.current_step === "rv" ? record.rv_conversation_id : record.am_conversation_id;
      const receipt = cp.execution_status === "running" && executionCheckpoint && convId && cp.execution_id ? await executionCheckpoint.load(convId, cp.execution_id) : null;
      if (receipt?.execution_id === cp.execution_id && receipt?.runner_stopped_at && receipt?.status === "completed" && Array.isArray(receipt.pending_tool_calls) && !receipt.pending_tool_calls.length && Array.isArray(receipt.completed_tool_calls) && receipt.handoff_result?.execution_id === cp.execution_id) {
        const parsed = cp.current_step === "se" ? { cleanText: receipt.handoff_result.text } : parseAmReviewVerdict(receipt.handoff_result.text); record = await checkpoint.complete(handoffId, record, { ...receipt.handoff_result, text: parsed.cleanText, ...(cp.current_step === "se" ? {} : { verdict: parsed.verdict }) });
      }
      if (record.status !== "completed" && record.checkpoint.execution_status !== "completed" && (record.checkpoint.execution_status !== "running" || !executionCheckpoint || receipt?.runner_stopped_at && receipt.status !== "running")) {
        const { safeRound, safeMaxRounds, safeNextStep, completed } = resolveSafeResumeState(record, record.checkpoint, maxRounds);
        const freshWorkspace = gitService ? await handoffWorkspaceSnapshot({ gitService, fileService, projectId, scopePaths: Array.isArray(record.checkpoint.workspace?.scope_paths) ? record.checkpoint.workspace.scope_paths : record.workspace_scope_paths }).catch(() => null) : null;
        record = await store.transition(handoffId, record.checkpoint.generation, (current) => ({ ...current, status: completed ? "completed" : "running", round: safeRound, max_rounds: safeMaxRounds, checkpoint: { ...current.checkpoint, round: safeRound, ...(freshWorkspace ? { workspace: freshWorkspace } : {}), current_step: null, next_step: safeNextStep, execution_status: completed ? "completed" : "pending", error_code: null } }));
        if (completed) return handoffResultPayload(record);
      }
    }
    const planJson = parseArchitecturePlanJSON(await fileService.readFile({ path: record.plan_source_path }));
    const invoke = async ({ record: active, step, round, executionId, previous }) => {
      const seResult = [...previous].reverse().find((item) => item.round === round && item.step === "se");
      const rvResult = [...previous].reverse().find((item) => item.round === round && item.step === "rv");
      const preceding = previous.at(-1);
      const basePrompt = step === "se"
        ? preceding?.verdict === "REVISE" ? `Please address the saved ${preceding.step.toUpperCase()} findings for round ${round}:\n${preceding.text}` : `Implement approved plan ${active.plan_id} r${active.plan_revision} (${active.plan_source_path}). Report implementation and verification evidence.`
        : step === "rv" ? buildRvImplementationReviewPrompt({ planJson, planId: active.plan_id, round, maxRounds: active.max_rounds, seReplyText: seResult?.text, workspace: active.checkpoint?.workspace })
          : buildAmAcceptanceReviewPrompt({ planJson, planId: active.plan_id, round, maxRounds: active.max_rounds, seReplyText: seResult?.text, rvReviewText: rvResult?.text });
      const drained = directiveInbox ? await directiveInbox.drainPending({ handoffId: active.handoff_id, targetRole: step === "se" ? "se" : step === "am" ? "am" : null, executionId, turnCount: round, receiptPosition: previous.length }) : { directives: [], pauseRequested: false };
      const prompt = drained.directives.length ? `${basePrompt}\n\n${formatMidFlightDirectives(drained.directives)}` : basePrompt;
      let raw;
      if (step === "se" && typeof se === "function") raw = await se({ agentId: active.se_agent_id, prompt, conversationId: active.se_conversation_id, linkedConversationId: active.am_conversation_id, handoffId: active.handoff_id, planId: active.plan_id, correlationId: executionId, phase: "implementation", round, withEvidence: true });
      else if (step === "rv" && typeof rv === "function") raw = await rv({ agentId: active.rv_agent_id, prompt, conversationId: active.rv_conversation_id, linkedConversationId: active.am_conversation_id, handoffId: active.handoff_id, planId: active.plan_id, correlationId: executionId, phase: "implementation", round, withEvidence: true });
      else if (step === "am" && typeof am === "function") raw = await am(prompt, active.am_conversation_id, { responseContentType: "text/markdown", exposeText: false, correlationId: executionId, handoffId: active.handoff_id, planId: active.plan_id, linkedConversationId: active.se_conversation_id, withEvidence: true, planningInputOnly: false });
      else throw Object.assign(new ConfigurationError("Role stream unavailable."), { code: "HANDOFF_ADAPTER_UNAVAILABLE" });
      if (drained.pauseRequested) throw Object.assign(new ConfigurationError("Execution paused at the requested turn boundary."), { code: "EXECUTION_PAUSED" });
      const parsed = step === "se" ? { cleanText: String(raw?.text ?? "").trim() } : parseAmReviewVerdict(raw?.text);
      if (parsed.cleanText && raw?.execution_id === executionId && raw?.terminal_status === "completed") publishDualConversationMessage({ sender: step === "se" ? { id: active.se_agent_id, role: "system_engineer" } : step === "rv" ? { id: active.rv_agent_id, role: "reviewer" } : { id: active.am_agent_id, role: "architecture_manager" }, recipient: step === "am" ? { id: active.se_agent_id, role: "system_engineer" } : { id: active.am_agent_id, role: "architecture_manager" }, messageType: step === "se" ? "system_engineer.message.received" : step === "rv" ? "reviewer.message.received" : "architecture.message.received", amConversationId: active.am_conversation_id, seConversationId: active.se_conversation_id, correlationId: executionId, text: parsed.cleanText, extraPayload: { handoff_id: active.handoff_id, plan_id: active.plan_id, phase: "implementation", round, ...(step === "se" ? {} : { verdict: parsed.verdict }) } });
      return { execution_id: raw?.execution_id, terminal_status: raw?.terminal_status, result_evidence: raw?.result_evidence, read_only_enforced: raw?.read_only_enforced, text: parsed.cleanText, ...(step === "se" ? {} : { verdict: parsed.verdict }) };
    };
    const hasStepAdapter = (step) => step === "se" ? typeof se === "function" : step === "rv" ? typeof rv === "function" : step === "am" ? typeof am === "function" : false;
    do {
      record = await checkpoint.resume(handoffId, { invoke, recoverResult: (step, receipt) => { const parsed = step === "se" ? { cleanText: receipt.text } : parseAmReviewVerdict(receipt.text); return { ...receipt, text: parsed.cleanText, ...(step === "se" ? {} : { verdict: parsed.verdict }) }; }, expectedRevision: record.plan_revision, expectedSha256: record.plan_sha256, expectedOwnerId: approvedOwnerId });
    } while (runToCompletion && record.status === "running" && record.checkpoint?.execution_status === "pending" && !record.checkpoint?.last_error && hasStepAdapter(record.checkpoint?.next_step));
    return handoffResultPayload(record);
  }

  // Business purpose: resumes only the next incomplete AM-SE critique turn from its durable checkpoint.
  // Technical description: reconstructs the role prompt from the pinned plan and saved critique result, invokes one role, and leaves implementation approval to the existing backend gate.
  async function resumeCritique({ handoffId, approvedOwnerId, requestSystemEngineer: se = requestSystemEngineer, requestArchitecture: am = requestArchitecture, requestReviewer: rv = requestReviewer } = {}) {
    return resumeAmSeCritique({ handoffId, projectId, store, critique, fileService, applyRevision: maybeApplyCritiqueRevision, se, am, withEvidence: Boolean(executionCheckpoint),
      finish: async (record) => {
        if (record.error_code === "CRITIQUE_CONSENSUS_REQUIRED") return { handoff_id: handoffId, phase: record.phase, status: "paused", reason: record.error_code };
        if (record.approval_mode === "explicit_owner_command" && approvedOwnerId) await markdownPlanStore.decide({ planId: record.plan_id, revision: record.plan_revision, sha256: record.plan_sha256, decision: "approved", approverId: approvedOwnerId });
        const approved = await checkpoint.verifyPlan(record);
        if (!approvedOwnerId || approved.decision?.approver_id !== approvedOwnerId) throw Object.assign(new ConfigurationError("Authenticated Owner approval is required before implementation."), { code: "PLAN_APPROVAL_REQUIRED", statusCode: 409 });
        if (record.delivery_target !== "se") throw Object.assign(new ConfigurationError("This handoff requires the sprint delivery adapter."), { code: "HANDOFF_ADAPTER_UNAVAILABLE", statusCode: 409 });
        await store.transition(handoffId, record.critique_checkpoint.generation, (current) => ({ ...current, phase: "implementation", status: "running", round: 1, error_code: null, checkpoint: { generation: 0, approval_pending: true } }));
        await checkpoint.initialize(handoffId, approvedOwnerId);
        return resumeHandoff({ handoffId, approvedOwnerId, requestSystemEngineer: se, requestArchitecture: am, requestReviewer: rv, runToCompletion: true });
      }
    });
  }

  // Business purpose: runs Phase 1 (1-2 rounds of AM-SE plan critique) and Phase 2 automatic handoff to SL or SE.
  // Technical description: publishes the human-readable brief, coordinates 1-2 rounds of AM-SE critique, auto-approves the unified revision, and dispatches either SL sprint generation or SE multi-round implementation and AM acceptance review.
  async function startHandoff({
    plan, planJson: suppliedPlanJson, intake = {}, deliveryTarget, conversationId, approvedOwnerId = "project-owner",
    approvePlan: turnApprovePlan = approvePlan, requestArchitecture: turnRequestArchitecture = requestArchitecture,
    requestSystemEngineer: turnRequestSystemEngineer = requestSystemEngineer, requestReviewer: turnRequestReviewer = requestReviewer
  } = {}) {
    const requestedTarget = deliveryTarget ?? intake.delivery_target;
    const explicitOwnerCommand = requestedTarget === "se" || requestedTarget === "sl";
    const target = requestedTarget === "sl" ? "sl" : "se";
    if (!checkpoint) throw Object.assign(new ConfigurationError("Handoff checkpoint is unavailable."), { code: "HANDOFF_CHECKPOINT_UNAVAILABLE", statusCode: 503 });
    if (typeof turnRequestArchitecture !== "function" || typeof turnRequestSystemEngineer !== "function" || typeof turnRequestReviewer !== "function") throw Object.assign(new ConfigurationError("All AM, SE, and RV handoff adapters are required."), { code: "HANDOFF_ADAPTER_UNAVAILABLE", statusCode: 503 });
    const seProfile = agentRoleResolver ? agentRoleResolver.resolveProfile("system_engineer") : { agent_id: "system-engineer", role: "system_engineer" };
    if (!seProfile?.agent_id) throw Object.assign(new ConfigurationError("No enabled System Engineer agent is available for automatic handoff."), { code: "SYSTEM_ENGINEER_UNAVAILABLE", statusCode: 409 });
    const amProfile = agentRoleResolver?.resolveProfile?.("architecture_manager") ?? { agent_id: "architecture-manager", role: "architecture_manager" };
    const rvProfile = agentRoleResolver?.resolveProfile?.("reviewer") ?? { agent_id: "reviewer", role: "reviewer" };

    let currentPlan = { plan_id: plan.plan_id, revision: plan.revision, sha256: plan.sha256, source_path: plan.source_path };
    const existingDecision = typeof markdownPlanStore.getRevision === "function" ? (await markdownPlanStore.getRevision({ planId: currentPlan.plan_id, revision: currentPlan.revision })).decision : null;
    const approvalMode = explicitOwnerCommand ? "explicit_owner_command" : existingDecision?.decision === "approved" && existingDecision.sha256 === currentPlan.sha256 ? "existing_decision" : "manual_panel_approval";
    let currentPlanJson = suppliedPlanJson ?? parseArchitecturePlanJSON(await fileService.readFile({ path: currentPlan.source_path }));
    const seConversationId = `CONV-SE-${currentPlan.plan_id}`;
    const rvConversationId = `CONV-RV-${currentPlan.plan_id}`;

    let record = await store.create({ handoffId: `HANDOFF-${currentPlan.plan_id}-R${currentPlan.revision}`, planId: currentPlan.plan_id, planRevision: currentPlan.revision, planSha256: currentPlan.sha256, planSourcePath: currentPlan.source_path, deliveryTarget: target, sourceKind: intake.source_kind ?? "conversation", sourceFilePath: intake.source_file_path ?? null, workspaceScopePaths: intake.workspace_scope_paths, approvalMode, amAgentId: amProfile.agent_id, seAgentId: seProfile.agent_id, rvAgentId: rvProfile.agent_id, amConversationId: conversationId, seConversationId, rvConversationId, phase: "plan_critique", status: "critiquing", maxCritiqueRounds, maxRounds });
    const displaySourcePath = typeof fileService?.resolveStoragePath === "function" ? fileService.resolveStoragePath(currentPlan.source_path) : currentPlan.source_path;
    const brief = formatHumanReadableHandoffBrief(currentPlanJson, { planId: currentPlan.plan_id, revision: currentPlan.revision, sourceKind: record.source_kind, sourceFilePath: record.source_file_path, planSourcePath: displaySourcePath, deliveryTarget: target });
    const correlationBase = `CORR-HANDOFF-${currentPlan.plan_id}`;
    publishDualConversationMessage({ sender: { id: amProfile.agent_id, role: "architecture_manager" }, recipient: { id: seProfile.agent_id, role: "system_engineer" }, messageType: "architecture.message.received", amConversationId: conversationId, seConversationId, correlationId: `${correlationBase}-BRIEF`, text: brief, extraPayload: { handoff_id: record.handoff_id, plan_id: currentPlan.plan_id, phase: "plan_critique" } });

    await critique.initialize(record.handoff_id);
    const history = [];
    let critiqueRound = 1;
    if (typeof turnRequestSystemEngineer === "function") {
      let critiquePrompt = `${brief}\n\n[Giai đoạn 1 - Phản biện kế hoạch (Vòng 1/${record.max_critique_rounds})]: Hãy khảo sát nhanh các file liên quan bằng công cụ đọc/tìm kiếm (chưa sửa file) và cho ý kiến phản biện kỹ thuật về bản kế hoạch trên. Kết thúc bằng [CRITIQUE: ALIGNED] hoặc [CRITIQUE: DISCUSS].`;
      for (critiqueRound = 1; critiqueRound <= record.max_critique_rounds; critiqueRound += 1) {
        const seTurn = await critique.run(record.handoff_id, { step: "se", round: critiqueRound, invoke: (executionId) => turnRequestSystemEngineer({ agentId: seProfile.agent_id, prompt: critiquePrompt, conversationId: seConversationId, linkedConversationId: conversationId, handoffId: record.handoff_id, planId: currentPlan.plan_id, correlationId: executionId, phase: "plan_critique", critiqueRound, round: critiqueRound, withEvidence: Boolean(executionCheckpoint) }) });
        record = seTurn.record;
        if (!seTurn.result) return { handoff_id: record.handoff_id, phase: "plan_critique", status: "paused", reason: record.critique_checkpoint.error_code };
        const { status: critiqueStatus, cleanText: seCritiqueText } = parseSePlanCritique(seTurn.result.text);
        publishDualConversationMessage({ sender: { id: seProfile.agent_id, role: "system_engineer" }, recipient: { id: amProfile.agent_id, role: "architecture_manager" }, messageType: "system_engineer.message.received", amConversationId: conversationId, seConversationId, correlationId: `${correlationBase}-CRITIQUE-SE-R${critiqueRound}`, text: seCritiqueText, extraPayload: { handoff_id: record.handoff_id, plan_id: currentPlan.plan_id, phase: "plan_critique", critique_round: critiqueRound, critique_status: critiqueStatus } });
        if (critiqueStatus === "ALIGNED") {
          history.push({ phase: "plan_critique", critique_round: critiqueRound, se_critique: seCritiqueText, critique_status: critiqueStatus, timestamp: new Date().toISOString() });
          record = await store.transition(record.handoff_id, record.critique_checkpoint.generation, (current) => ({ ...current, history, critique_round: critiqueRound, critique_checkpoint: { ...current.critique_checkpoint, next_step: null, execution_status: "completed" } }));
          break;
        }
        const amTurn = await critique.run(record.handoff_id, { step: "am", round: critiqueRound, invoke: (executionId) => typeof turnRequestArchitecture === "function"
          ? turnRequestArchitecture(buildAmCritiqueReplyPrompt({ planJson: currentPlanJson, planId: currentPlan.plan_id, seCritiqueText }), conversationId, { responseContentType: "text/markdown", exposeText: false, correlationId: executionId, handoffId: record.handoff_id, planId: currentPlan.plan_id, linkedConversationId: seConversationId, withEvidence: Boolean(executionCheckpoint), planningInputOnly: false })
          : "Architecture Manager đã ghi nhận và làm rõ các điểm phản biện của SE." });
        record = amTurn.record;
        if (!amTurn.result) return { handoff_id: record.handoff_id, phase: "plan_critique", status: "paused", reason: record.critique_checkpoint.error_code };
        let applied; try { applied = await maybeApplyCritiqueRevision({ rawAmReply: amTurn.result.text, currentPlan, currentPlanJson, conversationId }); } catch (error) { const errorCode = error?.code ?? "PLAN_PATCH_INVALID"; record = await store.update(record.handoff_id, { phase: "plan_critique", status: "paused", critique_round: critiqueRound, history, error_code: errorCode }); return { handoff_id: record.handoff_id, phase: "plan_critique", status: "paused", reason: errorCode, plan_id: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256, history }; }
        currentPlan = applied.currentPlan; currentPlanJson = applied.currentPlanJson;
        const resolvedStatus = critiqueRound >= record.max_critique_rounds && explicitOwnerCommand ? "ALIGNED" : critiqueStatus;
        history.push({ phase: "plan_critique", critique_round: critiqueRound, se_critique: seCritiqueText, am_reply: applied.cleanReply, critique_status: resolvedStatus, plan_revision: currentPlan.revision, timestamp: new Date().toISOString() });
        publishDualConversationMessage({ sender: { id: amProfile.agent_id, role: "architecture_manager" }, recipient: { id: seProfile.agent_id, role: "system_engineer" }, messageType: "architecture.message.received", amConversationId: conversationId, seConversationId, correlationId: `${correlationBase}-CRITIQUE-AM-R${critiqueRound}`, text: applied.cleanReply, extraPayload: { handoff_id: record.handoff_id, plan_id: currentPlan.plan_id, phase: "plan_critique", critique_round: critiqueRound, plan_revision: currentPlan.revision } });
        if (critiqueRound >= record.max_critique_rounds && !explicitOwnerCommand) {
          record = await store.update(record.handoff_id, { phase: "plan_critique", status: "paused", plan_revision: currentPlan.revision, plan_sha256: currentPlan.sha256, plan_source_path: currentPlan.source_path, critique_round: critiqueRound, history, error_code: "CRITIQUE_CONSENSUS_REQUIRED" });
          return { handoff_id: record.handoff_id, phase: "plan_critique", status: "paused", reason: "CRITIQUE_CONSENSUS_REQUIRED", plan_id: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256, history };
        }
        if (critiqueRound >= record.max_critique_rounds && explicitOwnerCommand) {
          record = await store.transition(record.handoff_id, record.critique_checkpoint.generation, (current) => ({ ...current, plan_revision: currentPlan.revision, plan_sha256: currentPlan.sha256, plan_source_path: currentPlan.source_path, history, critique_round: critiqueRound, critique_checkpoint: { ...current.critique_checkpoint, next_step: null, execution_status: "completed" } }));
          break;
        }
        record = await critique.advance(record.handoff_id, { round: critiqueRound, history, plan: currentPlan });
        critiquePrompt = `### Phản hồi làm rõ kế hoạch từ Architecture Manager (Vòng ${critiqueRound + 1}/${record.max_critique_rounds} - ${currentPlan.plan_id} r${currentPlan.revision})\n\n${applied.cleanReply}\n\nVui lòng xác nhận phương án đã thống nhất và kết thúc bằng [CRITIQUE: ALIGNED].`;
      }
    }

    let approvedPlan;
    if (explicitOwnerCommand) { const decision = await markdownPlanStore.decide({ planId: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256, decision: "approved", approverId: approvedOwnerId }); approvedPlan = await markdownPlanStore.assertApproved({ planId: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256 }); if (decision.approver_id !== approvedOwnerId || approvedPlan.decision?.approver_id !== approvedOwnerId) throw Object.assign(new ConfigurationError("Owner approval does not match."), { code: "PLAN_APPROVAL_OWNER_MISMATCH", statusCode: 409 }); }
    else try { approvedPlan = await markdownPlanStore.assertApproved({ planId: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256 }); if (!approvedOwnerId || approvedPlan.decision?.approver_id !== approvedOwnerId) throw new ConfigurationError("Authenticated Owner approval is required."); }
    catch { record = await store.update(record.handoff_id, { phase: "plan_critique", status: "paused", plan_revision: currentPlan.revision, plan_sha256: currentPlan.sha256, plan_source_path: currentPlan.source_path, critique_round: critiqueRound, history, error_code: "PLAN_APPROVAL_REQUIRED" }); return { handoff_id: record.handoff_id, phase: "plan_critique", status: "paused", reason: "PLAN_APPROVAL_REQUIRED", plan_id: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256, history }; }
    const consensusText = `### Chốt thống nhất kế hoạch giữa AM & SE: ${currentPlan.plan_id} (r${currentPlan.revision})\nArchitecture Manager và System Engineer đã hoàn tất ${critiqueRound} vòng phản biện kỹ thuật. Kế hoạch **${currentPlan.plan_id} r${currentPlan.revision}** có approval hợp lệ trước khi chuyển sang giai đoạn thực thi (**${target.toUpperCase()}**).`;
    publishDualConversationMessage({ sender: { id: amProfile.agent_id, role: "architecture_manager" }, recipient: { id: seProfile.agent_id, role: "system_engineer" }, messageType: "architecture.message.received", amConversationId: conversationId, seConversationId, correlationId: `${correlationBase}-CONSENSUS`, text: consensusText, extraPayload: { handoff_id: record.handoff_id, plan_id: currentPlan.plan_id, phase: "plan_critique", plan_revision: currentPlan.revision } });

    if (target === "sl") {
      record = await store.update(record.handoff_id, { phase: "sl_handoff", status: "running", plan_revision: currentPlan.revision, plan_sha256: currentPlan.sha256, plan_source_path: currentPlan.source_path, critique_round: critiqueRound, history });
      const approved = await turnApprovePlan({ planId: currentPlan.plan_id, conversationId, approvedOwnerId: approvedOwnerId || "project-owner", approvalRevision: currentPlan.revision, approvalSha256: currentPlan.sha256 });
      record = await store.update(record.handoff_id, { phase: "sl_handoff", status: "completed", history });
      const slDoneText = `Đã hoàn tất bàn giao kế hoạch **${currentPlan.plan_id} r${currentPlan.revision}** (sau khi AM & SE phản biện thống nhất) cho **Sprint Leader (SL)**. Sprint **${approved.sprint_id}** đã được tạo ở trạng thái **${approved.sprint_status ?? "ready"}**.`;
      publishDualConversationMessage({ sender: { id: amProfile.agent_id, role: "architecture_manager" }, recipient: { id: seProfile.agent_id, role: "system_engineer" }, messageType: "architecture.message.received", amConversationId: conversationId, seConversationId, correlationId: `${correlationBase}-SL-DONE`, text: slDoneText, extraPayload: { handoff_id: record.handoff_id, plan_id: currentPlan.plan_id, phase: "sl_handoff", sprint_id: approved.sprint_id } });
      return { ...approved, handoff_id: record.handoff_id, phase: "sl_handoff", status: "completed", delivery_target: "sl", plan_id: currentPlan.plan_id, revision: currentPlan.revision, sha256: currentPlan.sha256, se_conversation_id: seConversationId, critique_rounds_completed: critiqueRound, brief, history };
    }

    record = await store.update(record.handoff_id, { phase: "implementation", status: "running", round: 1, plan_revision: currentPlan.revision, plan_sha256: currentPlan.sha256, plan_source_path: currentPlan.source_path, critique_round: critiqueRound, history });
    record = await checkpoint.initialize(record.handoff_id, approvedOwnerId);
    return resumeHandoff({ handoffId: record.handoff_id, approvedOwnerId, requestArchitecture: turnRequestArchitecture, requestSystemEngineer: turnRequestSystemEngineer, requestReviewer: turnRequestReviewer, runToCompletion: true });
  }

  // Business purpose: projects every persisted handoff role and checkpoint result for Owner recovery controls.
  // Technical description: returns redacted state-machine evidence for AM, SE and RV without exposing prompts, workspace bytes or credentials.
  async function listHandoffs() {
    const records = typeof store.list === "function" ? await store.list() : [];
    const indexedPlanIds = typeof markdownPlanStore?.list === "function" ? new Set(markdownPlanStore.list().map((plan) => plan.plan_id)) : null;
    return records.filter((record) => !indexedPlanIds || indexedPlanIds.has(record.plan_id)).map(projectHandoffRecord);
  }

  // Business purpose: returns one redacted handoff projection for the Owner route without exposing prompts, credentials or workspace bytes.
  // Technical description: reuses the project-scoped list projection and returns a stable not-found error when the handoff is absent.
  async function getHandoff(handoffId) {
    const handoff = (await listHandoffs()).find((item) => item.handoff_id === handoffId);
    if (!handoff) throw Object.assign(new ConfigurationError("Handoff not found."), { code: "HANDOFF_NOT_FOUND", statusCode: 404 });
    return handoff;
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

  // Business purpose: reconciles one stopped or uncertain SE handoff without replaying an execution whose terminal state is unknown.
  // Technical description: verifies the project-scoped handoff identity and exact approved plan checksum, then delegates runner and workspace reconciliation to the durable checkpoint.
  async function reconcileHandoff({ handoffId, approvedOwnerId, expectedRevision, expectedSha256, operatorApproved = false } = {}) {
    if (!checkpoint) throw Object.assign(new ConfigurationError("Handoff checkpoint is unavailable."), { code: "HANDOFF_CHECKPOINT_UNAVAILABLE", statusCode: 503 });
    const record = await store.get(handoffId);
    if (!record || record.project_id !== projectId || record.delivery_target !== "se" || !approvedOwnerId || expectedRevision !== record.plan_revision || expectedSha256 !== record.plan_sha256) throw Object.assign(new ConfigurationError("Handoff identity is unavailable."), { code: "HANDOFF_IDENTITY_INVALID", statusCode: 409 });
    const approved = await checkpoint.verifyPlan(record);
    if (approved.decision?.approver_id !== approvedOwnerId) throw Object.assign(new ConfigurationError("Owner approval does not match."), { code: "PLAN_APPROVAL_OWNER_MISMATCH", statusCode: 409 });
    return checkpoint.reconcile(handoffId, { operatorApproved });
  }

  return Object.freeze({ startHandoff, resumeCritique, resumeHandoff, listHandoffs, getHandoff, pauseHandoff, handoffWorkspaceStatus, adoptHandoffWorkspace, reconcileHandoff });
}
