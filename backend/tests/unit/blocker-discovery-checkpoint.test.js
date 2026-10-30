// Verifies allowance renewal stays in the same SDK invocation and retains durable read progress across resume.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createBlockerRecoveryAgent } from "../../src/modules/supervisor/blocker/blocker-recovery-agent.js";
import { createDiscoveryProgress, discoveryAssignment, createDiscoveryCheckpointWriter } from "../../src/modules/supervisor/blocker/blocker-discovery-checkpoint.js";

for (const provider of ["openai", "codex", "claude"]) {
  test(`${provider} renews calls/output at saved checkpoints without restarting SDK or changing roles`, async () => {
    const fixture = await blockerRecoveryFixture();
    let invocations = 0;
    const logs = [];
    try {
      await fixture.base.fileService.atomicWrite({ path: "backend/discovery.js", content: "// Discovery fixture.\n" + "x".repeat(6000), replace: true });
      const gateway = { execute: async ({ options }) => {
        invocations += 1;
        for (let call = 1; call <= 35; call += 1) {
          let result;
          if (provider === "claude") {
            const handler = options.mcpServers.forge.instance.server._requestHandlers.get("tools/call");
            const reply = await handler({ method: "tools/call", params: { name: "read_file", arguments: { path: "backend/discovery.js", offset: 1, limit: 2 } } }, {});
            assert.notEqual(reply.isError, true);
            result = JSON.parse(reply.content[0].text);
          } else result = await options.forgeTools.registry.read_file.execute({ path: "backend/discovery.js", offset: 1, limit: 2 });
          assert.match(result.sha256, /^sha256:/);
          const job = (await fixture.ledger()).jobs[0];
          assert.equal(job.stage, "sprint_leader");
          assert.equal(job.status, "invoking");
          assert.equal(job.discovery_checkpoints.sprint_leader.calls, call);
          assert.equal(job.discovery_checkpoints.sprint_leader.receipts.length, call);
        }
        return { text: JSON.stringify(fixture.resolution) };
      } };
      const worker = createBlockerRecoveryAgent({ clock: () => 1000, projectLogger: (entry) => logs.push(entry),
        readFailureEvidence: async () => ({ status: "captured", receipts: [] }),
        agentResolver: { resolveAvailable: (role) => ({ agent_id: "SL", role, provider, enabled: true, status: "ready" }) },
        agentOccupancy: fixture.base.occupancy, resolveTicketWorkspace: async () => fixture.base.workspace,
        gateways: { openaiSdkGateway: gateway, claudeSdkGateway: gateway, codexSdkGateway: gateway } });
      fixture.recreate({ investigate: worker });
      await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
      await fixture.recovery.tick();
      const ledger = await fixture.ledger();
      const checkpoint = ledger.jobs[0].discovery_checkpoints.sprint_leader;
      assert.equal(invocations, 1);
      assert.equal(ledger.calls, 1);
      assert.equal(ledger.jobs[0].status, "resume_pending");
      assert(checkpoint.calls > 30 && checkpoint.bytes > 120_000);
      assert(checkpoint.call_allowance >= checkpoint.calls && checkpoint.byte_allowance >= checkpoint.bytes);
      assert(logs.some((entry) => entry.event_name === "supervisor.blocker_budget_renewed"));
      assert.equal(ledger.resumes, 0);
      await fixture.recovery.tick();
      assert.equal(fixture.base.integrations, 1);
    } finally { await fixture.close(); }
  });
}

test("reconstructed discovery retains receipts, paths and cumulative counters instead of starting from zero", async () => {
  const job = { id: "J", stage: "coder", request: { payload: { execution_id: "E" } }, coder_exchange: { request_id: "R" }, history: [] };
  let saved;
  const first = createDiscoveryProgress({ job, save: async (checkpoint) => { saved = checkpoint; } });
  await first.complete("read_file", { path: "backend/source.js" }, { sha256: "sha256:abc", content: "x".repeat(125000) }, new Set(["backend/source.js"]));
  const renewed = saved.renewals;
  job.discovery_checkpoints = { coder: saved };
  job.history.push({ event: "sprint_coder_coordination_restored", completed_at: 2 });
  const resumed = createDiscoveryProgress({ job, save: async (checkpoint) => { saved = checkpoint; } });
  assert.equal(resumed.snapshot().calls, 1);
  assert.deepEqual(resumed.snapshot().paths, ["backend/source.js"]);
  await resumed.complete("read_lines", { path: "backend/source.js", start_line: 2, end_line: 3 }, { stdout: "next" }, new Set(["backend/source.js"]));
  assert.equal(saved.calls, 2);
  assert.equal(saved.renewals, renewed);
  assert.equal(saved.receipts[0].tool, "read_file");
  assert.equal(saved.receipts[1].tool, "read_lines");
});

for (const boundary of ["cancelled", "source", "execution", "invocation"]) {
  test(`checkpoint renewal respects ${boundary} without persisting a new allowance`, async () => {
    const fixture = await blockerRecoveryFixture();
    try {
      await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
      await fixture.base.store.withLock("blocker.recovery", async () => {
        const ledger = await fixture.ledger();
        ledger.jobs[0].status = "invoking";
        await fixture.base.store.save("blocker.recovery", ledger);
      });
      const ledger = await fixture.ledger();
      const job = ledger.jobs[0];
      const write = createDiscoveryCheckpointWriter({ store: fixture.base.store, ledgerId: ledger.id, job, validate: async () => boundary !== "source" });
      if (boundary !== "source") await fixture.base.store.withLock("blocker.recovery", async () => {
        const current = await fixture.ledger();
        if (boundary === "cancelled") current.cancelled = true;
        else if (boundary === "execution") current.execution_id = "REPLACED";
        else current.jobs[0].invocation_id = "REPLACED-INVOCATION";
        await fixture.base.store.save("blocker.recovery", current);
      });
      await assert.rejects(write({ assignment_id: discoveryAssignment(job), sequence: 1 }, { renewed: true }));
      assert.equal((await fixture.ledger()).jobs[0].discovery_checkpoints, undefined);
    } finally { await fixture.close(); }
  });
}

test("deadline, cancellation and failed checkpoint persistence prevent returning the next tool result", async () => {
  const controller = new AbortController();
  const expired = createDiscoveryProgress({ job: {}, deadline: 1, clock: () => 2 });
  await assert.rejects(expired.complete("read_file", {}, {}, new Set()), { code: "BLOCKER_DISCOVERY_STOPPED" });
  const stopped = createDiscoveryProgress({ job: {}, abortSignal: controller.signal });
  controller.abort();
  await assert.rejects(stopped.complete("read_file", {}, {}, new Set()), { code: "BLOCKER_DISCOVERY_STOPPED" });
  const failed = createDiscoveryProgress({ job: {}, save: async () => { throw new Error("Checkpoint write failed"); } });
  await assert.rejects(failed.complete("read_file", {}, {}, new Set()), /Checkpoint write failed/);
});


// Concurrent SDK tool calls must wait for the preceding checkpoint grant to persist or fail.
test("parallel completions cannot return output past a failed checkpoint renewal", async () => {
  let saves = 0;
  const progress = createDiscoveryProgress({ job: {}, save: async () => { saves += 1; throw new Error("Renewal rejected"); } });
  const results = await Promise.allSettled([
    progress.complete("read_file", { path: "first.js" }, { content: "x".repeat(125000) }, new Set()),
    progress.complete("read_lines", { path: "next.js" }, { stdout: "next" }, new Set())
  ]);
  assert(results.every((result) => result.status === "rejected" && result.reason.message === "Renewal rejected"));
  assert.equal(saves, 1);
  assert.equal(progress.snapshot().sequence, 1);
});
