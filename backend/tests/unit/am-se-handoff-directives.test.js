// Business purpose: verifies that the AM-SE handoff orchestrator drains pending mid-flight directives for AM and SE at critique and implementation step boundaries, injects MID-FLIGHT DIRECTIVES into role prompts, and gracefully pauses at checkpoints when pause_after_turn is requested.
// Technical description: exercises createAmSeHandoffService with createTicketDirectiveInbox across startHandoff and resumeHandoff to confirm role-scoped directive injection and safe checkpoint pausing.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAmSeHandoffService } from "../../src/application/am-se-handoff-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketDirectiveInbox } from "../../src/modules/supervisor/ticket/ticket-directive-inbox.js";

const samplePlanJson = {
  title: "Directive Bridge Handoff Plan",
  objective: "Verify mid-flight directive injection in AM-SE handoff",
  background: "Handoff directive bridge test",
  scope: ["In scope: AM-SE directive draining"],
  outcomes: [
    {
      id: "O1",
      outcome: "Inject directives at turn boundary",
      acceptance_criteria: ["Directives appear in SE and AM prompts"],
      guardrails: ["Must preserve target_role isolation"]
    }
  ],
  evidence: [{ path: "backend/src/application/am-se-handoff-service.js", location: "L1-L50", fact: "Handoff orchestrator" }],
  assumptions: ["No additional assumptions."],
  constraints: [],
  risks: [],
  verification: "node --test"
};

test("AM-SE handoff service drains role-targeted directives into SE and AM prompts and honors pause_after_turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nf-handoff-directives-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fileService = createFileService({ projectRoot: root, role: "system_engineer", allowPlanStorage: true });
  const planSourcePath = ".forge/runtime/nf/planning/plans/PLAN-DIR-1/plan-source-r1.json";
  await fileService.atomicWrite({ path: planSourcePath, content: JSON.stringify(samplePlanJson), replace: true });

  const planSha = "b".repeat(64);
  const inbox = createTicketDirectiveInbox({ fileService, projectId: "PROJ-HANDOFF", projectRoot: root });
  const handoffId = "HANDOFF-PLAN-DIR-1-R1";

  // Pre-queue one directive for SE and one directive for AM before handoff starts.
  await inbox.enqueue({
    handoffId,
    targetRole: "se",
    sender: { id: "OWNER", role: "project_owner" },
    kind: "focus_constraint",
    instruction: "Chỉ sửa trong phạm vi module directive bridge."
  });
  await inbox.enqueue({
    handoffId,
    targetRole: "am",
    sender: { id: "OWNER", role: "project_owner" },
    kind: "implementation_guidance",
    instruction: "Kiểm tra kỹ tiêu chí O1 khi nghiệm thu kết quả của SE."
  });

  const markdownPlanStore = {
    getRevision: async () => ({ decision: { decision: "approved", approver_id: "OWNER", sha256: planSha } }),
    decide: async () => ({ approver_id: "OWNER", decision: "approved", sha256: planSha }),
    assertApproved: async () => ({
      plan_id: "PLAN-DIR-1",
      revision: 1,
      sha256: planSha,
      source_path: planSourcePath,
      project_id: "PROJ-HANDOFF",
      decision: { approver_id: "OWNER", decision: "approved", sha256: planSha }
    }),
    list: () => [{ plan_id: "PLAN-DIR-1", revision: 1, sha256: planSha }]
  };
  const gitService = {
    getHead: async () => "a".repeat(40),
    status: async () => "",
    indexEntries: async () => ""
  };

  const sePrompts = [];
  const amPrompts = [];
  const service = createAmSeHandoffService({
    projectId: "PROJ-HANDOFF",
    fileService,
    markdownPlanStore,
    gitService,
    directiveInbox: inbox
  });

  const completed = await service.startHandoff({
    plan: { plan_id: "PLAN-DIR-1", revision: 1, sha256: planSha, source_path: planSourcePath },
    planJson: samplePlanJson,
    deliveryTarget: "se",
    conversationId: "CONV-AM-DIR",
    approvedOwnerId: "OWNER",
    requestSystemEngineer: async (req) => {
      sePrompts.push(req.prompt);
      if (req.phase === "plan_critique") {
        return { text: "SE đồng thuận.\n[CRITIQUE: ALIGNED]", execution_id: req.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed", turn_completed: true } };
      }
      return { text: "SE đã hoàn thành O1.", execution_id: req.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed", turn_completed: true } };
    },
    requestReviewer: async (req) => ({
      text: "RV xác nhận đạt.\n[VERDICT: PASS]",
      execution_id: req.correlationId,
      terminal_status: "completed",
      result_evidence: { sdk_status: "completed", turn_completed: true },
      read_only_enforced: true
    }),
    requestArchitecture: async (prompt, _conv, options = {}) => {
      amPrompts.push(prompt);
      return { text: "AM nghiệm thu đạt.\n[VERDICT: PASS]", execution_id: options.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed", turn_completed: true } };
    }
  });

  assert.equal(completed.status, "completed");
  assert.match(sePrompts[0], /MID-FLIGHT DIRECTIVES/);
  assert.match(sePrompts[0], /Chỉ sửa trong phạm vi module directive bridge\./);
  assert.doesNotMatch(sePrompts[0], /Kiểm tra kỹ tiêu chí O1/, "AM directive must not leak into SE prompt");
  assert.match(amPrompts[0], /MID-FLIGHT DIRECTIVES/);
  assert.match(amPrompts[0], /Kiểm tra kỹ tiêu chí O1 khi nghiệm thu kết quả của SE\./);

  // Verify pause_after_turn transitions implementation handoff to paused with EXECUTION_PAUSED.
  const pausePlanPath = ".forge/runtime/nf/planning/plans/PLAN-DIR-2/plan-source-r1.json";
  await fileService.atomicWrite({ path: pausePlanPath, content: JSON.stringify(samplePlanJson), replace: true });
  const pausePlanStore = {
    ...markdownPlanStore,
    assertApproved: async () => ({
      plan_id: "PLAN-DIR-2",
      revision: 1,
      sha256: planSha,
      source_path: pausePlanPath,
      project_id: "PROJ-HANDOFF",
      decision: { approver_id: "OWNER", decision: "approved", sha256: planSha }
    })
  };
  const pauseService = createAmSeHandoffService({
    projectId: "PROJ-HANDOFF",
    fileService,
    markdownPlanStore: pausePlanStore,
    gitService,
    directiveInbox: inbox
  });

  const pausedResult = await pauseService.startHandoff({
    plan: { plan_id: "PLAN-DIR-2", revision: 1, sha256: planSha, source_path: pausePlanPath },
    planJson: samplePlanJson,
    deliveryTarget: "se",
    conversationId: "CONV-AM-PAUSE",
    approvedOwnerId: "OWNER",
    requestSystemEngineer: async (req) => {
      if (req.phase === "plan_critique") {
        // Queue a pause_after_turn directive for SE before implementation starts.
        await inbox.enqueue({
          handoffId: "HANDOFF-PLAN-DIR-2-R1",
          targetRole: "se",
          sender: { id: "OWNER", role: "project_owner" },
          kind: "pause_after_turn",
          instruction: "Tạm dừng SE trước bước thực thi."
        });
        return { text: "SE đồng thuận.\n[CRITIQUE: ALIGNED]", execution_id: req.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed", turn_completed: true } };
      }
      return { text: "Should not execute", execution_id: req.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed", turn_completed: true } };
    },
    requestReviewer: async (req) => ({ text: "[VERDICT: PASS]", execution_id: req.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed", turn_completed: true }, read_only_enforced: true }),
    requestArchitecture: async (_p, _c, options = {}) => ({ text: "[VERDICT: PASS]", execution_id: options.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed", turn_completed: true } })
  });

  assert.equal(pausedResult.status, "paused");
  assert.equal(pausedResult.reason, "EXECUTION_PAUSED");
});
