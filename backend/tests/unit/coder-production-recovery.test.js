// Verifies deployed recovery adapters across actual inline SDK failures, Stop, authority changes and restart.
import assert from "node:assert/strict";
import test from "node:test";
import { coderProductionRecoveryFixture, TICKET } from "../fixtures/coder-production-recovery-fixture.js";
import { coderRecoveryPolicy, coderFailureTriage } from "../../src/modules/supervisor/coder-recovery-policy.js";
import { sdkFailureEvidence } from "../../src/modules/agent/sdk-failure-evidence.js";
import { classifyCoderFailure } from "../../src/modules/supervisor/coder-failure-routing.js";
import { createProductionSupervisorRuntime } from "../../src/modules/supervisor/production-runtime.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";

test("RUN cannot replace pending recovery and another project cannot Stop it", async () => {
  const fixture = await coderProductionRecoveryFixture();
  try {
    await fixture.run();
    const dispatch = createTicketRunDispatch({ disposition: { get: async () => null }, intake: { open: async () => ({ ticket: TICKET }) },
      sprintRegistry: fixture.registry, ticketStatusStore: fixture.statusStore, checkpoints: fixture.checkpoints,
      coderRecovery: fixture.service, dispatchTask: async () => assert.fail("RUN must not replace pending recovery") });
    assert.equal((await dispatch({ projectId: "P", ticketId: "TASK", fresh: true })).reason, "operational_recovery_pending");
    await assert.rejects(dispatch.stop({ projectId: "OTHER", ticketId: "TASK" }), { code: "TICKET_NOT_RUNNING" });
    assert.equal(fixture.statusStore.get("TASK").status, "running");
    assert.equal(fixture.invocations, 1);
  } finally { await fixture.close(); }
});

test("production factory wires retry adapters without opening a workspace or starting workers", async () => {
  const fixture = await coderProductionRecoveryFixture();
  try {
    const runtime = createProductionSupervisorRuntime({ fileService: createFileService({ projectRoot: fixture.workspace.projectRoot }),
      projectRoot: fixture.workspace.projectRoot, ticketStatusStore: fixture.statusStore, sprintRegistry: fixture.registry,
      gitService: { status: async () => assert.fail("Factory must not collect changes") },
      ticketWorkspaceService: { open: async () => assert.fail("Factory must not launch a ticket") },
      toolGovernance: {}, autoStartWorkers: false });
    assert.equal(typeof runtime.coderRecovery.tick, "function");
    assert.equal(runtime.integration.submitTicket, runtime.coderRecovery.runTicket);
  } finally { await fixture.close(); }
});

test("D1 resolves explicit bounded defaults and rejects invalid deployment limits", () => {
  assert.deepEqual(coderRecoveryPolicy({}), { policy_id: "coder-operational-v1", max_retries: 2, deadline_ms: 600_000 });
  assert.equal(coderRecoveryPolicy({ NODEFORGE_CODER_RETRY_ENABLED: "false" }), null);
  for (const value of ["Infinity", "0", "-1", "2.5", "11"]) assert.throws(() => coderRecoveryPolicy({ NODEFORGE_CODER_MAX_RETRIES: value }));
  for (const value of ["30000", "NaN", "86400001"]) assert.throws(() => coderRecoveryPolicy({ NODEFORGE_CODER_RETRY_DEADLINE_MS: value }));
  assert.throws(() => coderRecoveryPolicy({ NODEFORGE_CODER_RETRY_ENABLED: "maybe" }));
});

test("D2 assigns triage without granting acceptance, access, contract or security authority", () => {
  for (const reason_code of ["SCOPE_CONFLICT", "ACCEPTANCE_AMBIGUOUS", "CONTRACT_DECISION_REQUIRED", "ACCESS_REQUIRED", "SECURITY_RISK"]) {
    const triage = coderFailureTriage({ code: "CODER_BLOCKED", details: { blocker: { reason_code }, evidence: ["report:1"] } });
    assert.equal(triage.triage_role, "sprint-leader");
    assert.deepEqual(triage.evidence_refs, ["report:1"]);
    assert.equal(triage.allowed_actions.includes("approve"), false);
    assert.equal(triage.allowed_actions.includes("close_finding"), false);
    if (["ACCESS_REQUIRED", "SECURITY_RISK", "CONTRACT_DECISION_REQUIRED"].includes(reason_code)) assert.equal(triage.decision_role, "owner");
  }
  assert.equal(coderFailureTriage({ code: "COMMIT_APPROVAL_REJECTED" }).decision_role, "owner");
});

test("D3 actual SDK exceptions retry after 30 seconds, preserve budgets on restart and fail exactly once", async () => {
  const fixture = await coderProductionRecoveryFixture();
  try {
    assert.equal((await fixture.run()).status, "recovery_pending");
    assert.equal(fixture.invocations, 1);
    assert.equal(fixture.events.length, 0);
    fixture.advance(29_999);
    await fixture.restart().tick();
    assert.equal(fixture.invocations, 1);
    fixture.advance(1);
    await fixture.service.tick();
    assert.equal(fixture.invocations, 2);
    fixture.advance(30_000);
    await fixture.restart().tick();
    assert.equal(fixture.invocations, 3);
    await fixture.service.tick();
    await fixture.restart().tick();
    assert.deepEqual(fixture.events.map((event) => event.type), ["task.failed"]);
    assert.equal(fixture.events[0].payload.reason, "CODER_RECOVERY_EXHAUSTED");
    assert.equal(fixture.statusStore.get().status, "failed");
    assert.equal(fixture.integrations, 0);
    const [ledger] = await fixture.store.list("coder-operational-recovery");
    assert.equal(ledger.retries, 2);
    assert.equal(ledger.failures.length, 3);
    assert.equal(ledger.policy.deadline_ms, 600_000);
  } finally { await fixture.close(); }
});

test("D3 retry resumes Coder checkpoint and completes through normal integration", async () => {
  const fixture = await coderProductionRecoveryFixture({ behavior: async ({ onEvent }, invocation) => {
    if (invocation === 1) throw sdkFailureEvidence(Object.assign(new Error("Rejected"), { code: "CONFIGURATION_ERROR" }), { status: 503 });
    for (const tool of ["write_diff", "commit_changes", "report_done"]) await onEvent({ type: "item.completed", item: { id: tool, type: "mcp_tool_call", server: "forge", tool, status: "completed" } });
    return { text: "Reported" };
  } });
  try {
    await fixture.run(); fixture.advance(30_000);
    await fixture.restart().tick();
    assert.equal(fixture.invocations, 2);
    assert.equal(fixture.integrations, 1);
    assert.equal(fixture.statusStore.get().status, "done");
    assert.deepEqual(fixture.events.map((event) => event.type), ["task.completed"]);
  } finally { await fixture.close(); }
});

test("D3 Stop during the wait durably cancels recovery, even after process reconstruction", async () => {
  const fixture = await coderProductionRecoveryFixture();
  try {
    await fixture.run();
    await fixture.service.stopTicket({ projectId: "P", ticketId: "TASK" });
    fixture.advance(30_000);
    await fixture.restart().tick();
    assert.equal(fixture.invocations, 1);
    assert.equal((await fixture.store.list("coder-operational-recovery"))[0].cancelled, true);
    assert.equal(fixture.events[0].payload.reason, "TICKET_STOPPED");
  } finally { await fixture.close(); }
});

test("D3 stale source, cancelled disposition, replaced execution and revoked plan cannot dispatch", async () => {
  for (const mutation of ["staleSource", "cancelDisposition", "replaceExecution", "revokePlan"]) {
    const fixture = await coderProductionRecoveryFixture();
    try {
      await fixture.run(); fixture[mutation](); fixture.advance(30_000);
      await fixture.restart().tick();
      assert.equal(fixture.invocations, 1, mutation);
      assert.equal(fixture.integrations, 0, mutation);
      assert.equal((await fixture.store.list("coder-operational-recovery"))[0].failures[0].status, "cancelled");
    } finally { await fixture.close(); }
  }
});

test("D3 timeout and lost connection without terminal evidence are not automatically replayable", () => {
  assert.equal(classifyCoderFailure(sdkFailureEvidence({ code: "CONFIGURATION_ERROR" }, { code: "ETIMEDOUT" })), "reconcile");
  assert.equal(classifyCoderFailure(sdkFailureEvidence({ code: "CONFIGURATION_ERROR" }, { status: 503 }, { aborted: true })), "reconcile");
  assert.equal(classifyCoderFailure(sdkFailureEvidence({ code: "CONFIGURATION_ERROR" }, { code: "EAI_AGAIN" }, { ended: true })), "transient");
  assert.equal(classifyCoderFailure(sdkFailureEvidence({ code: "CONFIGURATION_ERROR" }, { status: 401 })), "terminal");
});

test("D3 Stop interrupts a retry already executing at the actual SDK boundary", async () => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const fixture = await coderProductionRecoveryFixture({ behavior: async ({ abortSignal }, invocation) => {
    if (invocation === 1) throw sdkFailureEvidence(Object.assign(new Error("Rejected"), { code: "CONFIGURATION_ERROR" }), { status: 503 });
    entered();
    return new Promise((_resolve, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true }));
  } });
  try {
    await fixture.run(); fixture.advance(30_000);
    const dispatch = fixture.service.tick();
    await started;
    await fixture.service.stopTicket({ projectId: "P", ticketId: "TASK" });
    await dispatch;
    fixture.advance(30_000); await fixture.restart().tick();
    assert.equal(fixture.invocations, 2);
    assert.equal(fixture.integrations, 0);
    assert.equal(fixture.statusStore.get().status, "failed");
    assert.equal(fixture.events.filter((event) => event.type === "task.failed").length, 1);
  } finally { await fixture.close(); }
});

test("D3 competing runtime adapters cannot invoke the same durable retry twice", async () => {
  const fixture = await coderProductionRecoveryFixture();
  try {
    await fixture.run(); fixture.advance(30_000);
    const first = fixture.service;
    const second = fixture.restart();
    await Promise.all([first.tick(), second.tick()]);
    assert.equal(fixture.invocations, 2);
    assert.equal((await fixture.store.list("coder-operational-recovery"))[0].retries, 2);
  } finally { await fixture.close(); }
});

test("D3 unknown provider outcome retains launch ownership across restart without redispatch", async () => {
  const fixture = await coderProductionRecoveryFixture({ behavior: async () => {
    throw sdkFailureEvidence(Object.assign(new Error("Timeout"), { code: "CONFIGURATION_ERROR" }), {}, { aborted: true });
  } });
  try {
    await assert.rejects(fixture.run(), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
    assert.ok(fixture.statusStore.get().details.launch_claim);
    fixture.advance(600_000); await fixture.restart().tick();
    assert.equal(fixture.invocations, 1);
    assert.equal(fixture.integrations, 0);
  } finally { await fixture.close(); }
});

test("D2 blocked SDK report carries structured evidence into durable triage without approval", async () => {
  const fixture = await coderProductionRecoveryFixture({ behavior: async ({ onEvent }) => {
    const details = { blocker: { reason_code: "SECURITY_RISK" }, evidence: ["src/auth.js:12"] };
    await onEvent({ type: "item.completed", item: { id: "blocked", type: "mcp_tool_call", server: "forge", tool: "report_done",
      status: "failed", result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error_code: "CODER_BLOCKED", message: "Security decision required", details }) }] } } });
    return { text: "Blocked" };
  } });
  try {
    await assert.rejects(fixture.run(), { code: "CODER_BLOCKED" });
    const checkpoint = await fixture.checkpoints.load("TASK");
    assert.equal(checkpoint.triage.decision_role, "owner");
    assert.deepEqual(checkpoint.triage.evidence_refs, ["src/auth.js:12"]);
    assert.equal(fixture.events[0].type, "task.needs_human_review");
    assert.equal(fixture.integrations, 0);
    assert.deepEqual(await fixture.store.list("coder-operational-recovery"), []);
  } finally { await fixture.close(); }
});
