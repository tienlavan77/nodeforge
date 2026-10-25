/** Covers durable Owner question delivery, authenticated answers and SL resume
 * without converting technical reconciliation into automatic execution approval. */
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { validateTechnicalReconciliation } from "../../src/modules/supervisor/blocker-technical-reconciliation.js";
import { blockerOwnerRequest } from "../../src/modules/supervisor/blocker-owner-request.js";
import { routeTicketReview } from "../../src/transport/http/forge-v1-ticket-review-routes.js";
import { blockerExchangeRequest, blockerExchangeResponse } from "../../src/modules/supervisor/blocker-agent-exchange.js";
import { createForgeV1ConversationRoutes } from "../../src/transport/http/forge-v1-conversation-routes.js";
import { createExecutionEventBus } from "../../src/modules/supervisor/execution-event-bus.js";

/** Supplies an explicit human question whose answer cannot itself authorize a
 * denied tool; both policy escalation and ordinary technical waits remain distinct. */
function pending(typed = true) {
  return { action: "reconciliation_required", summary: "Direct Owner input is missing.", guidance: "Disclose the attempted operation and retained denial to the Owner.",
    reconciliation: { kind: "tooling", prerequisite: "Obtain the direct answer.", completed_checks: ["AM answered the approved design question."],
      next_check: "Consume the direct answer without clearing actual tool authorization.",
      waiting_for: [{ owner: "external", operation: "execute", question: "Will the Owner provide the direct response?" }],
      ...(typed ? { owner_request: { kind: "tool_authorization", question: "Do you approve the exact disclosed operation?", context: "The tool rejected the operation because direct permission was missing." } } : {}) } };
}

/** Parks a real durable recovery execution and exposes its exact displayed
 * request for stale-tab, duplicate-delivery and process-restart regressions. */
async function fixtureInput({ typed = true, resolved = false } = {}) {
  const seen = [];
  const fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    seen.push(structuredClone(job));
    return resolved && job.owner_inputs?.length ? { ...resolution,
      technical_result: { findings: ["Owner supplied the missing fact."], implementation_steps: ["Continue the existing permitted handler."],
        verification_steps: ["Run the focused handler check."], admission: { status: "within_existing_permissions", rationale: "Fixture handler already uses existing permissions." } } } : pending(typed);
  } });
  await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
  for (let tick = 0; tick < 4; tick += 1) await fixture.recovery.tick();
  const request = await fixture.recovery.getOwnerRequest({ projectId: "P", ticketId: "TASK" });
  const input = { requestedProjectId: "P", ticketId: "TASK", actor: "authenticated-owner", jobId: request.job_id,
    executionId: request.execution_id, requestId: request.request_id, answer: "I supply the requested fact; preserve tool controls." };
  return { fixture, request, input, seen };
}

test("typed Owner request is explicit and ordinary reconciliation is not an Owner decision", () => {
  assert.doesNotThrow(() => validateTechnicalReconciliation(pending()));
  for (const change of [{ kind: "approve_all" }, { context: "" }, { question: "" }, { grant_permissions: true }]) {
    const value = pending(); Object.assign(value.reconciliation.owner_request, change);
    assert.throws(() => validateTechnicalReconciliation(value), { code: "BLOCKER_DISPOSITION_INVALID" });
  }
  const value = pending(); value.action = "resolved";
  assert.throws(() => validateTechnicalReconciliation(value), { code: "BLOCKER_DISPOSITION_INVALID" });
  assert.equal(blockerOwnerRequest({ status: "reconciliation_required", job_id: "J", waiting_for: [{ owner: "coder", question: "Read source" }] }, "E"), null);
  assert.equal(blockerOwnerRequest({ status: "owner_required", job_id: "J", waiting_for: [{ owner: "external", question: "Decide" }] }, "E"), null);
});

test("shared SDK exchange accepts the typed request and preserves its exact question", () => {
  const job = { id: "J", stage: "sprint_leader", history: [], request: { project_id: "P", task_id: "T", agent_id: "coder",
    payload: { execution_id: "E" }, ticket: {} } };
  const request = blockerExchangeRequest(job, { agent_id: "SL", role: "sprint_leader" });
  const response = blockerExchangeResponse(pending(), request);
  assert.deepEqual(response.value.reconciliation.owner_request, pending().reconciliation.owner_request);
  assert.equal(response.response.payload.outcome, "needs_evidence");
});

test("an exact already answered question requests a correction instead of asking Owner again", () => {
  const job = { id: "J", request: { payload: { execution_id: "E" } } };
  const value = pending();
  const request = blockerOwnerRequest({ status: value.action, job_id: job.id, waiting_for: value.reconciliation.waiting_for,
    owner_request: value.reconciliation.owner_request, guidance: value.guidance }, "E");
  job.owner_inputs = [{ input_id: "I", request_id: request.request_id, answer: "Direct response already supplied" }];
  assert.throws(() => validateTechnicalReconciliation(value, job), (error) => error.validation_errors[0].reason === "owner_input_already_supplied");
});

test("legacy explicit external wait exposes full retained guidance read-only without inventing tool approval", async () => {
  const { fixture, request } = await fixtureInput({ typed: false });
  try {
    assert.equal(request.kind, "information");
    assert.equal(request.question, pending(false).reconciliation.waiting_for[0].question);
    assert.equal(request.context, pending(false).guidance);
    assert.equal((await fixture.base.checkpoints.load("TASK")).blocker_owner_inputs, undefined);
    assert.equal(await fixture.recovery.getOwnerRequest({ projectId: "OTHER", ticketId: "TASK" }), null);
  } finally { await fixture.close(); }
});

test("answer survives restart and reaches SL once before normal Coder resume, preserving failure and checkpoint", async () => {
  const { fixture, input, request, seen } = await fixtureInput({ resolved: true });
  try {
    const before = await fixture.base.checkpoints.load("TASK");
    const result = await fixture.recovery.respondOwnerInput(input);
    assert.equal(result.receipt.request.question, request.question);
    const saved = await fixture.base.checkpoints.load("TASK");
    assert.deepEqual(saved.failure, before.failure);
    assert.equal(saved.last_completed_turn, before.last_completed_turn);
    assert.equal(saved.blocker_recovery.status, "reconciliation_required");
    assert.equal(saved.blocker_recovery.execution_admission, before.blocker_recovery.execution_admission);
    assert.equal(fixture.base.invocations, 1, "Owner input alone never launches Coder");
    fixture.recreate(); await fixture.recovery.tick();
    const resumed = seen.at(-1);
    assert.equal(resumed.stage, "sprint_leader");
    assert.equal(resumed.owner_inputs[0].answer, input.answer);
    assert.equal((await fixture.ledger()).jobs[0].status, "resume_pending");
    const calls = fixture.calls.length;
    const duplicate = await fixture.recovery.respondOwnerInput(input);
    assert.equal(duplicate.receipt.input_id, result.receipt.input_id);
    assert.equal((await fixture.base.checkpoints.load("TASK")).blocker_owner_inputs.length, 1);
    await fixture.recovery.tick();
    assert.equal(fixture.calls.length, calls);
    assert.equal(fixture.base.invocations, 2);
    assert.equal(fixture.base.integrations, 1);
  } finally { await fixture.close(); }
});

test("stale question, job, execution, project, changed duplicate and stopped recovery reject answers", async () => {
  const { fixture, input } = await fixtureInput();
  try {
    for (const change of [{ requestId: "other" }, { jobId: "other" }, { executionId: "other" }, { requestedProjectId: "other" }])
      await assert.rejects(fixture.recovery.respondOwnerInput({ ...input, ...change }), (error) => error.statusCode === 409);
    assert.equal((await fixture.base.checkpoints.load("TASK")).blocker_owner_inputs, undefined);
    await fixture.recovery.respondOwnerInput(input);
    await assert.rejects(fixture.recovery.respondOwnerInput({ ...input, answer: "A conflicting answer" }), { code: "BLOCKER_OWNER_INPUT_RECORDED" });
    const ledger = await fixture.ledger(); ledger.cancelled = true; await fixture.base.store.save("blocker.recovery", ledger);
    await assert.rejects(fixture.recovery.respondOwnerInput(input), { code: "BLOCKER_OWNER_INPUT_UNAVAILABLE" });
    await fixture.recovery.tick();
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
    assert.equal(fixture.base.invocations, 1);
  } finally { await fixture.close(); }
});

test("response endpoint requires Owner authentication and ignores a caller-supplied actor", async () => {
  let received;
  const route = { method: "POST", parts: ["tickets", "TASK", "blocker-response"], projectId: "P",
    body: { job_id: "J", execution_id: "E", request_id: "Q", actor: "spoofed", answer: "Exact direct answer" },
    ticketBlockerDecisionService: { respond: async (input) => { received = input; return { status: "recorded" }; } } };
  await assert.rejects(routeTicketReview(route)); assert.equal(received, undefined);
  await assert.rejects(routeTicketReview({ ...route, planOwnerAuth: { verify: () => { throw new Error("Unauthorized"); } } }));
  assert.equal(received, undefined);
  const result = await routeTicketReview({ ...route, headers: { authorization: "Bearer fixture" }, planOwnerAuth: { verify: (headers) => {
    assert.equal(headers.authorization, "Bearer fixture"); return "authenticated-owner";
  } } });
  assert.equal(result.status, 200); assert.equal(received.actor, "authenticated-owner");
  assert.equal(received.answer, route.body.answer);
});

test("dashboard checkpoint distinguishes an external reply from an AM owner decision", async () => {
  const checkpoint = { task_id: "T", status: "blocked", blocker_recovery: { status: "reconciliation_required", waiting_for: [{ owner: "external", question: "Provide evidence" }] } };
  const routes = createForgeV1ConversationRoutes({ listResumableCheckpoints: async () => [checkpoint] });
  const [technicalSprint] = await routes.withCheckpointSummary([{ tickets: [{ id: "T" }] }]);
  const technical = technicalSprint.tickets[0];
  assert.equal(technical.checkpoint.blocker_owner_input, true);
  assert.equal(technical.checkpoint.blocker_owner_decision, false);
  checkpoint.blocker_recovery = { status: "owner_required" };
  const [policySprint] = await routes.withCheckpointSummary([{ tickets: [{ id: "T" }] }]);
  const policy = policySprint.tickets[0];
  assert.equal(policy.checkpoint.blocker_owner_input, false);
  assert.equal(policy.checkpoint.blocker_owner_decision, true);
});

/** Replays the production notification failure with the real validating bus;
 * a retained retry must finish without another provider call or lost Owner answer. */
test("failed UI notification recovers with complete execution metadata and publishes the Owner answer", async () => {
  const { fixture, input } = await fixtureInput();
  try {
    const ledger = await fixture.ledger();
    const job = ledger.jobs.at(-1);
    job.status = "notification_pending";
    job.outcome_reason = "CONFIGURATION_ERROR";
    job.last_error = "Execution event requires task_id and supervisor_id.";
    await fixture.base.store.save("blocker.recovery", ledger);
    const events = [], logs = [];
    const bus = createExecutionEventBus({ validate: (event) => {
      for (const key of ["task_id", "supervisor_id", "request_id", "correlation_id"]) assert.equal(event[key], job.request[key]);
      assert.equal(event.attempt, 1);
      assert.equal(typeof event.timestamp, "string");
      return true;
    } });
    bus.subscribe("*", async (event) => { events.push(event); });
    fixture.recreate({ eventBus: bus, projectLogger: (entry) => logs.push(entry) });
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs.at(-1).status, "reconciliation_required");
    assert(events.some((event) => event.type === "ticket.updated" && event.payload.reason === "blocker_owner_input_required"));
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "sprint_leader"], "Notification retry must not invoke another agent");
    await fixture.recovery.respondOwnerInput(input);
    assert(events.some((event) => event.type === "ticket.updated" && event.payload.reason === "blocker_owner_input_recorded"));
    assert.equal(logs.some((entry) => entry.event_name === "ticket.blocker_owner_input_publish_failed"), false);
    assert.equal((await fixture.base.checkpoints.load("TASK")).blocker_owner_inputs.length, 1);
  } finally { await fixture.close(); }
});

/** Reconstructs the production sequence: Owner answers, SL omits a required
 * handoff field twice, and notification must retain the answer and actual cause. */
test("SL schema failure after Owner response stays a correction without reopening Owner input", async () => {
  const { fixture, input } = await fixtureInput();
  try {
    const recorded = await fixture.recovery.respondOwnerInput(input);
    assert.equal(await fixture.recovery.getOwnerRequest({ projectId: "P", ticketId: "TASK" }), null);
    fixture.recreate({ investigate: async () => fixture.resolution });
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    const job = (await fixture.ledger()).jobs[0];
    assert.equal(job.status, "reconciliation_required");
    assert.equal(job.outcome_reason, "disposition_correction_no_progress");
    assert.equal(job.owner_inputs[0].input_id, recorded.receipt.input_id);
    assert.equal(job.validation_feedback[0].path, "/technical_result");
    const saved = await fixture.base.checkpoints.load("TASK");
    assert.equal(saved.blocker_recovery.owner_response.input_id, recorded.receipt.input_id);
    assert.deepEqual(saved.blocker_recovery.waiting_for, []);
    assert.equal(await fixture.recovery.getOwnerRequest({ projectId: "P", ticketId: "TASK" }), null);
    assert.equal(fixture.base.invocations, 1, "An invalid SL handoff never dispatches Coder");
    assert.equal((await fixture.recovery.respondOwnerInput(input)).receipt.input_id, recorded.receipt.input_id);
  } finally { await fixture.close(); }
});
