// Business purpose: continue interrupted plan critique from durable role results through the approval boundary.
// Technical description: resumes unfinished roles and round finalization separately, preserving saved answers.
import { ConfigurationError } from "../shared/errors.js";
import { parseArchitecturePlanJSON } from "../modules/governance/architecture-plan-json.js";
import { buildAmCritiqueReplyPrompt, formatHumanReadableHandoffBrief, parseSePlanCritique } from "./am-se-handoff-helpers.js";

// Business purpose: let Owner recovery continue at the first unfinished operation instead of replaying a completed role.
// Technical description: consumes saved results before invoking agents and finalizes rounds before advancing the checkpoint.
export async function resumeAmSeCritique({ handoffId, projectId, store, critique, fileService, applyRevision, se, am, withEvidence, finish }) {
  for (;;) {
    let record = await store.get(handoffId);
    const cp = record?.critique_checkpoint;
    if (!record || record.project_id !== projectId || record.phase !== "plan_critique" || !cp) {
      throw Object.assign(new ConfigurationError("Critique checkpoint is unavailable."), { code: "HANDOFF_CRITIQUE_REQUIRED", statusCode: 409 });
    }
    if (cp.execution_status === "completed") return finish(record);
    const planJson = parseArchitecturePlanJSON(await fileService.readFile({ path: record.plan_source_path }));
    const seResult = cp.results.find((item) => item.step === "se" && item.round === cp.round);
    const amResult = cp.results.find((item) => item.step === "am" && item.round === cp.round);
    const parsed = seResult ? parseSePlanCritique(seResult.text) : null;
    if (parsed?.status === "ALIGNED") {
      record = await store.transition(handoffId, cp.generation, (current) => ({
        ...current, status: "paused", critique_round: cp.round, error_code: null,
        history: [...(current.history ?? []).filter((item) => item.critique_round !== cp.round), {
          phase: "plan_critique", critique_round: cp.round, se_critique: parsed.cleanText,
          critique_status: "ALIGNED", timestamp: new Date().toISOString()
        }],
        critique_checkpoint: { ...current.critique_checkpoint, current_step: null, next_step: null, execution_status: "completed", error_code: null }
      }));
      return finish(record);
    }
    if (amResult) {
      const applied = await applyRevision({
        rawAmReply: amResult.text,
        currentPlan: { plan_id: record.plan_id, revision: record.plan_revision, sha256: record.plan_sha256, source_path: record.plan_source_path },
        currentPlanJson: planJson, conversationId: record.am_conversation_id
      });
      const lastRound = cp.round >= record.max_critique_rounds;
      const resolvedStatus = lastRound && record.approval_mode === "explicit_owner_command" ? "ALIGNED" : "DISCUSS";
      const history = [...(record.history ?? []).filter((item) => item.critique_round !== cp.round), {
        phase: "plan_critique", critique_round: cp.round, se_critique: parsed?.cleanText,
        am_reply: applied.cleanReply, critique_status: resolvedStatus,
        plan_revision: applied.currentPlan.revision, timestamp: new Date().toISOString()
      }];
      if (!lastRound) {
        await critique.advance(handoffId, { round: cp.round, history, plan: applied.currentPlan });
        continue;
      }
      record = await store.transition(handoffId, cp.generation, (current) => ({
        ...current, history, critique_round: cp.round, status: "paused",
        plan_revision: applied.currentPlan.revision, plan_sha256: applied.currentPlan.sha256,
        plan_source_path: applied.currentPlan.source_path,
        error_code: resolvedStatus === "ALIGNED" ? null : "CRITIQUE_CONSENSUS_REQUIRED",
        critique_checkpoint: { ...current.critique_checkpoint, current_step: null, next_step: null,
          execution_status: "completed", error_code: null, plan_revision: applied.currentPlan.revision, plan_sha256: applied.currentPlan.sha256 }
      }));
      if (resolvedStatus === "ALIGNED") return finish(record);
      return { handoff_id: handoffId, phase: record.phase, status: "paused", reason: "CRITIQUE_CONSENSUS_REQUIRED" };
    }
    const step = seResult ? "am" : "se";
    const adapter = step === "se" ? se : am;
    if (typeof adapter !== "function") throw Object.assign(new ConfigurationError("Critique role adapter is unavailable."), { code: "HANDOFF_ADAPTER_UNAVAILABLE", statusCode: 503 });
    const brief = formatHumanReadableHandoffBrief(planJson, { planId: record.plan_id, revision: record.plan_revision, planSourcePath: record.plan_source_path, deliveryTarget: record.delivery_target });
    const prompt = step === "se"
      ? `${brief}\n\nCritique round ${cp.round}/${record.max_critique_rounds}. Review the current plan and finish with [CRITIQUE: ALIGNED] or [CRITIQUE: DISCUSS].`
      : buildAmCritiqueReplyPrompt({ planJson, planId: record.plan_id, seCritiqueText: parsed?.cleanText ?? "" });
    const turn = await critique.run(handoffId, { step, round: cp.round, invoke: (executionId) => step === "se"
      ? se({ agentId: record.se_agent_id, prompt, conversationId: record.se_conversation_id, linkedConversationId: record.am_conversation_id, handoffId, planId: record.plan_id, correlationId: executionId, phase: "plan_critique", critiqueRound: cp.round, round: cp.round, withEvidence })
      : am(prompt, record.am_conversation_id, { responseContentType: "text/markdown", exposeText: false, planningInputOnly: false, correlationId: executionId, handoffId, planId: record.plan_id, linkedConversationId: record.se_conversation_id, withEvidence }) });
    if (!turn.result) return { handoff_id: handoffId, phase: "plan_critique", status: "paused", reason: turn.record.critique_checkpoint.error_code, checkpoint: turn.record.critique_checkpoint };
  }
}
