// Business purpose: verifies Piece D (Mid-Flight Directive Inbox & Turn-Boundary Injection) so authorized roles can steer or gracefully pause a running Coder ticket at turn boundaries with strict multi-project isolation.
// Technical description: exercises createTicketDirectiveInbox (enqueue, list, drainPending, role validation, supersedePending, project isolation) and runTicketSdkTurns directive injection, stall exemption, and pause_after_turn handling.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketDirectiveInbox, formatMidFlightDirectives } from "../../src/modules/supervisor/ticket/ticket-directive-inbox.js";
import { buildResumePrompt, createResumeState, recordTurn } from "../../src/modules/supervisor/ticket/ticket-resume.js";
import { runTicketSdkTurns } from "../../src/modules/supervisor/ticket/ticket-sdk-turns.js";

// Business purpose: creates an isolated temporary project root and FileService for directive inbox tests.
// Technical description: allocates a mkdtemp directory and registers automatic cleanup on the test context.
async function createInboxFixture(t, projectId = "PROJ-ALPHA") {
  const root = await mkdtemp(join(tmpdir(), "nf-directive-inbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fileService = createFileService({ projectRoot: root, role: "system_engineer" });
  const logs = [];
  const inbox = createTicketDirectiveInbox({
    fileService,
    projectId,
    projectRoot: root,
    projectLogger: (entry) => logs.push(entry)
  });
  return { root, fileService, inbox, logs };
}

test("Piece D: directive inbox enforces sender role authorization, instruction bounds, idempotency, supersedePending, and multi-project isolation", async (t) => {
  const alpha = await createInboxFixture(t, "PROJ-ALPHA");
  const beta = createTicketDirectiveInbox({
    fileService: alpha.fileService,
    projectId: "PROJ-BETA",
    projectRoot: alpha.root
  });

  await assert.rejects(
    alpha.inbox.enqueue({ taskId: "TICKET-1", sender: { id: "CODER-1", role: "coder" }, instruction: "Bypass scope" }),
    { code: "DIRECTIVE_SENDER_UNAUTHORIZED" }
  );
  await assert.rejects(
    alpha.inbox.enqueue({ taskId: "TICKET-1", sender: { id: "OWNER", role: "project_owner" }, instruction: "   " }),
    { code: "DIRECTIVE_INSTRUCTION_INVALID" }
  );
  await assert.rejects(
    alpha.inbox.enqueue({ taskId: "TICKET-1", sender: { id: "OWNER", role: "project_owner" }, kind: "invalid_kind", instruction: "Valid text" }),
    { code: "DIRECTIVE_KIND_INVALID" }
  );

  const first = await alpha.inbox.enqueue({
    taskId: "TICKET-1",
    sender: { id: "OWNER", role: "project_owner" },
    kind: "implementation_guidance",
    instruction: "Prefer helper A over helper B."
  });
  // Idempotent duplicate enqueue returns the same directive record.
  const duplicate = await alpha.inbox.enqueue({
    taskId: "TICKET-1",
    sender: { id: "OWNER", role: "project_owner" },
    kind: "implementation_guidance",
    instruction: "Prefer helper A over helper B."
  });
  assert.equal(first.directive_id, duplicate.directive_id);
  assert.equal((await alpha.inbox.list("TICKET-1")).length, 1);

  // Superseding prior pending directive of the same kind marks the earlier one superseded.
  const second = await alpha.inbox.enqueue({
    taskId: "TICKET-1",
    sender: { id: "SL-1", role: "sprint_leader" },
    kind: "implementation_guidance",
    instruction: "Use helper C instead.",
    supersedePending: true
  });
  assert.notEqual(first.directive_id, second.directive_id);
  const allAlpha = await alpha.inbox.list("TICKET-1");
  assert.equal(allAlpha.find((d) => d.directive_id === first.directive_id).status, "superseded");
  assert.equal(allAlpha.find((d) => d.directive_id === second.directive_id).status, "pending");

  // Multi-project isolation: PROJ-BETA cannot see PROJ-ALPHA directives for the same taskId.
  assert.deepEqual(await beta.list("TICKET-1"), []);

  const drained = await alpha.inbox.drainPending({ taskId: "TICKET-1", turnCount: 5, receiptPosition: 3 });
  assert.equal(drained.directives.length, 1);
  assert.equal(drained.directives[0].directive_id, second.directive_id);
  assert.equal(drained.directives[0].status, "delivered");
  assert.equal(drained.directives[0].delivered_at_turn, 5);
  assert.equal(drained.pauseRequested, false);

  // Subsequent drain returns empty without re-delivering.
  const drainedAgain = await alpha.inbox.drainPending({ taskId: "TICKET-1", turnCount: 6, receiptPosition: 4 });
  assert.deepEqual(drainedAgain, { directives: [], pauseRequested: false });
});

test("Piece D: runTicketSdkTurns drains mid-flight directives at turn boundary, exempts one stall cycle, and injects directives into the next prompt and resume state", async (t) => {
  const { inbox } = await createInboxFixture(t, "PROJ-DIRECTIVE");
  const state = createResumeState({
    status: "in_progress",
    session_id: "CLAUDE-SESS",
    last_completed_turn: 2,
    completed_tools: ["read_file"],
    changed_paths: [],
    coder_rules_read: true
  });

  const progressJson = JSON.stringify({
    kind: "work_progress",
    subject: "Discovery complete",
    payload: { status: "discovery_complete", next_action: "implement", summary: "Ready", remaining_work: ["Implement"] },
    evidence: []
  });

  const calls = [];
  const saved = [];
  const turns = [
    { text: progressJson, events: [{ tool: "read_file", status: "success" }] },
    // Turn 2 has 0 new tool events, which would normally trigger AGENT_PROGRESS_STALLED,
    // but a mid-flight directive arrives before Turn 2 finishes!
    { text: progressJson, events: [] },
    {
      text: "Done",
      events: [
        { tool: "edit_diff", status: "success" },
        { tool: "commit_changes", status: "success" },
        { tool: "report_done", status: "success" }
      ]
    }
  ];

  await runTicketSdkTurns({
    selected: { agent_id: "CODER", role: "coder", provider: "claude" },
    request: { task_id: "TICKET-STEER", project_id: "PROJ-DIRECTIVE", correlation_id: "CORR-STEER" },
    resumeState: state,
    prompt: "Initial assignment",
    priorTools: ["read_file"],
    directiveInbox: inbox,
    checkpoints: { save: async (snapshot) => saved.push(structuredClone(snapshot)) },
    readToolEvents: (res) => res.events ?? [],
    executeTurn: async (turnPrompt) => {
      const idx = calls.length;
      calls.push(turnPrompt);
      if (idx === 1) {
        // Enqueue a directive while Turn 2 is in flight so it is drained at the end of Turn 2.
        await inbox.enqueue({
          taskId: "TICKET-STEER",
          sender: { id: "AM-1", role: "architecture_manager" },
          kind: "focus_constraint",
          instruction: "Keep validation inside ticket-sdk-turns.js only."
        });
      }
      const step = turns[idx];
      for (const ev of step.events ?? []) recordTurn(state, ev.tool, {}, {});
      return { turn_completed: true, ...step };
    }
  });

  assert.equal(calls.length, 3);
  assert.match(calls[2], /MID-FLIGHT DIRECTIVES/);
  assert.match(calls[2], /Keep validation inside ticket-sdk-turns\.js only\./);
  assert.equal(state.deliveredDirectives.length, 1);
  assert.equal(saved.at(-1).delivered_directives.length, 1);

  const resumedPrompt = buildResumePrompt("Base assignment", state, { agentId: "CODER", provider: "claude" });
  assert.match(resumedPrompt, /MID-FLIGHT DIRECTIVES/);
  assert.match(formatMidFlightDirectives(state.deliveredDirectives), /focus_constraint/);
});

test("Piece D: pause_after_turn directive gracefully pauses execution at the turn boundary and saves a paused_by_directive checkpoint", async (t) => {
  const { inbox, logs } = await createInboxFixture(t, "PROJ-PAUSE");
  await inbox.enqueue({
    taskId: "TICKET-PAUSE",
    sender: { id: "OWNER", role: "project_owner" },
    kind: "pause_after_turn",
    instruction: "Pause after the current turn so Owner can inspect intermediate changes."
  });

  const state = createResumeState({
    status: "in_progress",
    session_id: "CLAUDE-PAUSE",
    last_completed_turn: 1,
    completed_tools: ["read_file"],
    changed_paths: ["backend/src/a.js"],
    coder_rules_read: true
  });
  const saved = [];
  const progressJson = JSON.stringify({
    kind: "work_progress",
    subject: "Discovery complete",
    payload: { status: "discovery_complete", next_action: "implement", summary: "Finished discovery", remaining_work: ["Edit file"] },
    evidence: []
  });

  await assert.rejects(
    runTicketSdkTurns({
      selected: { agent_id: "CODER", role: "coder", provider: "claude" },
      request: { task_id: "TICKET-PAUSE", project_id: "PROJ-PAUSE", correlation_id: "CORR-PAUSE" },
      resumeState: state,
      prompt: "Initial assignment",
      priorTools: ["read_file"],
      directiveInbox: inbox,
      checkpoints: { save: async (snapshot) => saved.push(structuredClone(snapshot)) },
      projectLogger: (entry) => logs.push(entry),
      readToolEvents: (res) => res.events ?? [],
      executeTurn: async () => {
        recordTurn(state, "read_file", { path: "backend/src/a.js" }, {});
        return { turn_completed: true, text: progressJson, events: [{ tool: "read_file", status: "success" }] };
      }
    }),
    { code: "DIRECTIVE_PAUSE_REQUESTED" }
  );

  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, "paused_by_directive");
  assert.equal(saved[0].sdk_turn_progress.status, "paused_by_directive");
  assert.equal(saved[0].delivered_directives.length, 1);
  assert.ok(logs.some((entry) => entry.event_name === "supervisor.sdk_turn_paused_by_directive"));
});
