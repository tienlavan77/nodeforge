// Verifies automatic investigation uses bounded read-only SDK tools and preserves unknown provider ownership.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createBlockerRecoveryAgent } from "../../src/modules/supervisor/blocker/blocker-recovery-agent.js";
import { blockerRecoveryTools } from "../../src/modules/supervisor/blocker/blocker-recovery-tools.js";

test("Codex profiles investigate through their Codex SDK with read-only Forge tools", async () => {
  const fixture = await blockerRecoveryFixture();
  let released = 0;
  const profile = { agent_id: "SL", role: "sprint_leader", provider: "codex", enabled: true, status: "ready" };
  try {
    const worker = createBlockerRecoveryAgent({ agentResolver: { resolveAvailable: () => profile },
      agentOccupancy: { claim: async () => ({ claim_id: "CLAIM" }), release: async () => { released += 1; } },
      resolveTicketWorkspace: async () => fixture.base.workspace,
      gateways: { openaiSdkGateway: { execute: async () => assert.fail("Codex must not fall back to the OpenAI Agents gateway") }, codexSdkGateway: { execute: async (input) => {
        assert.equal(input.agent, profile);
        assert.match(input.prompt, /BLOCKER-DECISION-HTTP/);
        assert.match(input.prompt, /Do not ask the owner to choose the same direction again/);
        assert.match(input.prompt, /SL ROLE CONTRACT/);
        assert.match(input.prompt, /authority_scope\?: sprint, coder_request/);
        assert.match(input.prompt, /Every technical reconciliation goes to AM for decision/);
        assert.match(input.prompt, /AM returns its decision to SL; only SL coordinates Coder/);
        assert.doesNotMatch(input.prompt, /do not ask AM to rubber-stamp|AM retains Architecture\/contract decisions only/);
        assert.doesNotMatch(input.prompt, /FULFILLMENT STAGE for recorded owner decision/);
        assert.deepEqual(input.options.forgeTools.definitions.map((definition) => definition.name), ["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff"]);
        assert.equal(input.options.builtinWebSearch, undefined);
        assert.equal(input.options.sandboxMode, "read-only");
        assert.equal(input.options.networkAccessEnabled, true);
        assert.equal(input.options.webSearchMode, "live");
        const source = await input.options.forgeTools.registry.read_file.execute({ path: fixture.evidence.path });
        assert.equal(source.sha256, `sha256:${fixture.evidence.sha256}`);
        assert.equal(input.options.forgeTools.registry.write_diff, undefined);
        return { text: JSON.stringify(fixture.resolution) };
      } } } });
    const result = await worker({ id: "JOB", fulfillment_decision_id: "BLOCKER-DECISION-HTTP", owner_decisions: [{ decision_id: "BLOCKER-DECISION-HTTP", option_id: "http_management_route" }], stage: "sprint_leader", request: { task_id: "TASK", ticket: fixture.ticket }, history: [] }, { deadline: Date.now() + 1000 });
    assert.equal(result.action, "resolved");
    assert.equal(released, 1);
  } finally { await fixture.close(); }
});

test("timed out SDK never releases a potentially active provider claim or silently replays", async () => {
  const fixture = await blockerRecoveryFixture();
  let released = 0;
  let abortSignal;
  try {
    const worker = createBlockerRecoveryAgent({ agentResolver: { resolveAvailable: () => ({ agent_id: "ARCH", role: "architecture_manager", provider: "openai", enabled: true, status: "ready" }) },
      agentOccupancy: { claim: async () => ({ claim_id: "CLAIM" }), release: async () => { released += 1; } },
      resolveTicketWorkspace: async () => fixture.base.workspace,
      gateways: { openaiSdkGateway: { execute: async (input) => { abortSignal = input.abortSignal; return new Promise(() => {}); } } } });
    await assert.rejects(worker({ id: "JOB", stage: "architecture_manager", request: { task_id: "TASK", ticket: fixture.ticket }, history: [] }, { deadline: Date.now() + 20 }), { code: "BLOCKER_PROVIDER_UNKNOWN" });
    assert.equal(abortSignal.aborted, true);
    assert.equal(released, 0);
  } finally { await fixture.close(); }
});

test("read-only investigation keeps traversal forbidden without exhausting allowance for permitted reads", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const logs = [];
    const tools = blockerRecoveryTools({ fileService: fixture.base.fileService, projectRoot: fixture.base.workspace.projectRoot,
      profile: { agent_id: "SL", role: "sprint_leader" }, task_id: "TICKET-1", correlation_id: "BLOCKER-JOB-SL", projectLogger: (entry) => logs.push(entry) });
    for (let count = 0; count < 30; count += 1) await assert.rejects(tools.registry.read_file.execute({ path: "../outside" }));
    assert.equal((await tools.registry.read_file.execute({ path: fixture.evidence.path })).sha256, `sha256:${fixture.evidence.sha256}`);
    // Every probe (accepted or rejected) is audited by tool name and outcome only, with a fixed budget-exhaustion failure line.
    assert.equal(logs.filter((entry) => entry.event_name === "supervisor.blocker_tool_call" && entry.status === "started").length, 31);
    assert.equal(logs.filter((entry) => entry.status === "failed").length, 30);
    assert.equal(logs.at(-1).status, "success");
    const toolLogs = logs.filter((entry) => entry.event_name === "supervisor.blocker_tool_call");
    assert(toolLogs.every((entry) => entry.task_id === "TICKET-1" && entry.correlation_id === "BLOCKER-JOB-SL"));
    assert(toolLogs.every((entry) => entry.payload.tool === "read_file" && entry.payload.agent_id === "SL"));
    assert.equal(JSON.stringify(logs).includes("../outside"), false);
    assert.equal(JSON.stringify(toolLogs).includes(fixture.evidence.path), false);
  } finally { await fixture.close(); }
});

// Discovery probes appear in terminal and panel audits before any provider disposition is returned.
test("successful and rejected discovery calls audit bounded lifecycle lines around the investigation", async () => {
  const fixture = await blockerRecoveryFixture();
  const logs = [];
  try {
    const worker = createBlockerRecoveryAgent({ projectLogger: (entry) => logs.push(entry),
      agentResolver: { resolveAvailable: () => ({ agent_id: "AM", role: "architecture_manager", provider: "openai", enabled: true, status: "ready" }) },
      agentOccupancy: { claim: async () => ({ claim_id: "CLAIM" }), release: async () => {} },
      resolveTicketWorkspace: async () => fixture.base.workspace,
      gateways: { openaiSdkGateway: { execute: async (input) => {
        await input.options.forgeTools.registry.read_file.execute({ path: fixture.evidence.path });
        await assert.rejects(input.options.forgeTools.registry.list_files.execute({ flags: ["--pre=command"] }));
        return { text: JSON.stringify(fixture.resolution) };
      } } } });
    await worker({ id: "JOB", stage: "architecture_manager", request: { task_id: "TICKET-1", ticket: fixture.ticket }, history: [] }, { deadline: Date.now() + 1000 });
    const calls = logs.filter((entry) => entry.event_name === "supervisor.blocker_tool_call");
    assert.deepEqual(calls.map((entry) => [entry.payload.tool, entry.status]), [["read_file", "started"], ["read_file", "success"], ["list_files", "started"], ["list_files", "failed"]]);
    assert(calls.every((entry) => entry.correlation_id === "BLOCKER-JOB-architecture_manager"));
    // Lifecycle events share the same correlation so all triage activity merges into one Coding panel run.
    for (const name of ["supervisor.blocker_triage_started", "supervisor.blocker_triage_finished"]) {
      const entry = logs.find((log) => log.event_name === name);
      assert.equal(entry.correlation_id, "BLOCKER-JOB-architecture_manager");
    }
    assert.equal(JSON.stringify(calls).includes(fixture.evidence.path), false);
  } finally { await fixture.close(); }
});

test("Stop aborts an active local SL investigation without declaring its provider outcome safe", async () => {
  const fixture = await blockerRecoveryFixture();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  try {
    const worker = createBlockerRecoveryAgent({ agentResolver: { resolveAvailable: () => ({ agent_id: "SL", role: "sprint_leader", provider: "openai", enabled: true, status: "ready" }) },
      agentOccupancy: { claim: async () => ({ claim_id: "CLAIM" }), release: async () => assert.fail("Unknown claim must be retained") },
      resolveTicketWorkspace: async () => fixture.base.workspace,
      gateways: { openaiSdkGateway: { execute: async () => { started(); return new Promise(() => {}); } } } });
    const running = worker({ id: "JOB", stage: "sprint_leader", request: { task_id: "TASK", ticket: fixture.ticket }, history: [] }, { deadline: Date.now() + 1000 });
    await ready; worker.cancel("TASK");
    await assert.rejects(running, { code: "BLOCKER_PROVIDER_UNKNOWN" });
  } finally { await fixture.close(); }
});

test("tool preparation failures never call a provider or report a successful investigation", async () => {
  const fixture = await blockerRecoveryFixture();
  const logs = [];
  let released = 0;
  try {
    const worker = createBlockerRecoveryAgent({ projectLogger: (entry) => logs.push(entry),
      agentResolver: { resolveAvailable: () => ({ agent_id: "SL", role: "sprint_leader", provider: "openai", enabled: true, status: "ready" }) },
      agentOccupancy: { claim: async () => ({ claim_id: "CLAIM" }), release: async () => { released += 1; } },
      resolveTicketWorkspace: async () => ({ path: fixture.base.workspace.projectRoot, fileService: {} }),
      gateways: { openaiSdkGateway: { execute: async () => assert.fail("Preparation failed before any provider invocation") } } });
    await assert.rejects(worker({ id: "JOB", stage: "sprint_leader", request: { task_id: "TASK", ticket: fixture.ticket }, history: [] },
      { deadline: Date.now() + 1000 }), { code: "CONFIGURATION_ERROR" });
    assert.equal(released, 1);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, "failed");
    assert.equal(logs[0].payload.provider_started, false);
  } finally { await fixture.close(); }
});

test("a completed malformed SDK response is audited and corrected with feedback, not treated as an unknown invocation", async () => {
  const fixture = await blockerRecoveryFixture();
  let calls = 0;
  let released = 0;
  try {
    const worker = createBlockerRecoveryAgent({ agentResolver: { resolveAvailable: () => ({ agent_id: "SL", role: "sprint_leader", provider: "openai", enabled: true, status: "ready" }) },
      agentOccupancy: { claim: async () => ({ claim_id: "CLAIM" }), release: async () => { released += 1; } },
      resolveTicketWorkspace: async () => fixture.base.workspace,
      gateways: { openaiSdkGateway: { execute: async ({ prompt }) => {
        calls += 1;
        if (calls === 1) return { text: "{incomplete-json" };
        assert.match(prompt, /json_invalid/);
        assert.match(prompt, /incomplete-json/);
        assert.match(prompt, /authority_reference/);
        return { text: JSON.stringify(fixture.resolution) };
      } } } });
    fixture.recreate({ investigate: worker });
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal(calls, 2);
    assert.equal(released, 2);
    assert.equal((await fixture.ledger()).jobs[0].disposition_attempts[0].response.text, "{incomplete-json");
    assert.equal(fixture.base.integrations, 1);
  } finally { await fixture.close(); }
});

test("extracts a valid JSON disposition when an agent prefixes discovery notes before a single fenced JSON block", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const worker = createBlockerRecoveryAgent({ agentResolver: { resolveAvailable: () => ({ agent_id: "AM", role: "architecture_manager", provider: "claude", enabled: true, status: "ready" }) },
      agentOccupancy: { claim: async () => ({ claim_id: "CLAIM" }), release: async () => {} },
      resolveTicketWorkspace: async () => fixture.base.workspace,
      gateways: { claudeSdkGateway: { execute: async ({ prompt }) => {
        assert.match(prompt, /AM may decide technical\/policy choices already covered by the approved plan/);
        assert.match(prompt, /AM may return action=resolved directly/);
        assert.match(prompt, /no separate Node admission step/i);
        assert.match(prompt, /if all six flags are false, return resolved only when the blocker is actually cleared, otherwise reconciliation_required/);
        return { text: `Based on my investigation:\n1. Confirmed contract boundary.\n\n\`\`\`json\n${JSON.stringify({ ...fixture.resolution, boundary_assessment: null, architecture_basis: null })}\n\`\`\`` };
      } } } });
    const result = await worker({ id: "JOB", fulfillment_decision_id: "BLOCKER-DECISION-1", stage: "architecture_manager", request: { task_id: "TASK", ticket: fixture.ticket }, history: [] }, { deadline: Date.now() + 1000 });
    assert.equal(result.action, "resolved");
  } finally { await fixture.close(); }
});
