// Verifies original failed edits reach AM with exact identities and no new log-reading capability.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBlockerFailureEvidence } from "../../src/modules/supervisor/blocker-failure-evidence.js";
import { createBlockerRecoveryAgent } from "../../src/modules/supervisor/blocker-recovery-agent.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

const job = { stage: "architecture_manager", failure_at: "2026-10-18T16:15:25.044Z",
  request: { project_id: "P", task_id: "TASK", request_id: "REQ", correlation_id: "CORR" } };

// Creates a failed edit receipt with the original requested replacement and denial text.
function event(overrides = {}) {
  return { project_id: "P", task_id: "TASK", correlation_id: "CORR", timestamp: "2026-10-18T16:14:33.943Z",
    event_id: "EVENT", event_name: "supervisor.agent_tool_event", status: "failed",
    payload: { request_id: "REQ", tool: "edit_diff", arguments: { path: "backend/start.js", anchor: "initialize();", replacement: "" },
      error: { message: "Rejected: preserve existing lifecycle initialization." } }, ...overrides };
}

test("Project Log Service supplies exact denied changes and responses, excluding foreign runs and later events", async () => {
  const root = await mkdtemp(join(tmpdir(), "blocker-evidence-"));
  try {
    const path = join(root, ".forge/runtime/nf/project.log");
    await mkdir(join(root, ".forge/runtime/nf"), { recursive: true });
    const original = event();
    const events = [original, event({ project_id: "OTHER" }), event({ task_id: "OTHER" }), event({ correlation_id: "OTHER" }),
      event({ payload: { ...original.payload, request_id: "OTHER" } }), event({ timestamp: "2026-10-18T16:16:00.000Z" })];
    await writeFile(path, events.map((entry) => JSON.stringify(entry)).join("\n"));
    const evidence = await createBlockerFailureEvidence()(job, root);
    assert.equal(evidence.status, "captured");
    assert.equal(evidence.receipts.length, 1);
    assert.deepEqual(evidence.receipts[0].arguments, original.payload.arguments);
    assert.deepEqual(evidence.receipts[0].error, original.payload.error);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("receipt lookup is cached by full failure identity and marks unavailable, missing and partial evidence explicitly", async () => {
  let calls = 0;
  const load = createBlockerFailureEvidence({ readEvents: async () => { calls += 1; return { events: [], warnings: [] }; } });
  assert.equal((await load({}, "/project")).status, "unavailable");
  assert.equal(calls, 0);
  assert.equal((await load(job, "/project")).status, "missing");
  await load(job, "/project");
  assert.equal(calls, 1);
  await load({ ...job, failure_at: "2026-10-18T16:16:00.000Z" }, "/project");
  assert.equal(calls, 2);
  const original = event();
  const protectedEvent = event({ payload: { ...original.payload, arguments: { path: ".forge/private.json" } } });
  const oversized = event({ payload: { ...original.payload, arguments: { ...original.payload.arguments, replacement: "x".repeat(50_000) } } });
  const partial = await createBlockerFailureEvidence({ readEvents: async () => ({ events: [original, protectedEvent, oversized], warnings: [] }) })(job, "/project");
  assert.equal(partial.status, "partial");
  assert.equal(partial.omitted, 2);
  assert.equal(partial.receipts.length, 1);
});

test("SL and AM receive failed commit receipts alongside edits without exposing foreign runs", async () => {
  const original = event();
  const commit = event({ payload: { ...original.payload, tool: "commit_changes", arguments: { message: "Commit ticket changes" } } });
  const readEvents = async () => ({ events: [commit, event({ task_id: "OTHER" })], warnings: [] });
  const operational = await createBlockerFailureEvidence({ readEvents, toolNames: null, requirePath: false })(job, "/project");
  assert.equal(operational.status, "captured");
  assert.deepEqual(operational.receipts.map((entry) => entry.tool), ["commit_changes"]);
  assert.equal((await createBlockerFailureEvidence({ readEvents })(job, "/project")).status, "captured");
  assert.equal((await createBlockerFailureEvidence({ readEvents, toolNames: ["edit_diff", "write_diff"] })(job, "/project")).status, "missing");
});

test("a checkpoint report resolves explicit prior denial references only within its execution correlation", async () => {
  const id = "LOG-15c7ae97-0064-4dda-98fc-9424d4bac9d8";
  const original = event({ event_id: id });
  original.payload.request_id = "PRIOR-CHECKPOINT";
  original.payload.error = { message: "This action was rejected due to unacceptable risk.\nReason: The operation expands a permission boundary." };
  const report = event({ event_id: "REPORT", payload: { request_id: "REQ", tool: "report_done", error: { code: "CODER_BLOCKED" },
    arguments: { evidence: [{ type: "tool_receipt", reference: id }] } } });
  const readEvents = async () => ({ events: [original, report, event({ event_id: "UNREFERENCED", payload: original.payload }),
    { ...original, project_id: "OTHER" }, { ...original, task_id: "OTHER" }, { ...original, correlation_id: "OTHER" },
    { ...original, timestamp: "2026-10-18T16:16:00.000Z" }], warnings: [] });
  const evidence = await createBlockerFailureEvidence({ readEvents })(job, "/project");
  assert.equal(evidence.status, "captured");
  assert.deepEqual(evidence.receipts.map((receipt) => receipt.event_id), [id]);
  assert.equal(evidence.receipts[0].request_id, "PRIOR-CHECKPOINT");
  assert.deepEqual(evidence.receipts[0].arguments, original.payload.arguments);
});

for (const provider of ["openai", "claude"]) {
  test(`${provider} AM receives original failed edit receipts in the recovery prompt`, async () => {
    const fixture = await blockerRecoveryFixture();
    try {
      const gateway = { execute: async ({ prompt }) => {
        assert.match(prompt, /original-denial-fixture/);
        assert.match(prompt, /never approval/);
        return { text: JSON.stringify(fixture.resolution) };
      } };
      const worker = createBlockerRecoveryAgent({
        agentResolver: { resolveAvailable: () => ({ agent_id: "AM", role: "architecture_manager", provider, enabled: true, status: "ready" }) },
        agentOccupancy: { claim: async () => ({ claim_id: "CLAIM" }), release: async () => {} },
        resolveTicketWorkspace: async () => fixture.base.workspace,
        readFailureEvidence: async () => ({ status: "captured", receipts: [{ error: "original-denial-fixture" }] }),
        gateways: { openaiSdkGateway: gateway, claudeSdkGateway: gateway }
      });
      await worker({ ...job, id: "JOB", request: { ...job.request, ticket: fixture.ticket }, history: [] }, { deadline: Date.now() + 2000 });
    } finally { await fixture.close(); }
  });
}
