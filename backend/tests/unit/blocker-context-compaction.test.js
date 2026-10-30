/** Exercises large retained recovery evidence across prompt construction, SDK
 * boundaries and restart. Compact delivery must preserve the exact AM question,
 * paginated evidence access, native schemas and the original Coder checkpoint. */
import test from "node:test";
import assert from "node:assert/strict";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createBlockerPromptContext, createBlockerPromptRefresh } from "../../src/modules/supervisor/blocker/blocker-prompt-context.js";
import { blockerRecoveryTools } from "../../src/modules/supervisor/blocker/blocker-recovery-tools.js";
import { createBlockerRecoveryAgent } from "../../src/modules/supervisor/blocker/blocker-recovery-agent.js";

/** Supplies a bounded consultation alongside large historical data, so growing
 * evidence cannot silently turn one repair-routing question into a full audit. */
async function contextFixture(t) {
  const f = await blockerRecoveryFixture();
  t.after(() => f.close());
  const question = "Which frontend owner should repair the 375px Saved-state failure?";
  const basis = { plan_id: "ARCH-CONTEXT", revision: 2, sha256: "a".repeat(64) };
  const job = { id: "J", stage: "architecture_manager", reason_code: "SCOPE_CONFLICT", history: [],
    request: { project_id: "P", task_id: "TASK", payload: { execution_id: "E" }, execution_context: { source_revision: "SOURCE" }, ticket: f.ticket },
    consultation_request: { question, decision_needed: "Return the frontend owner handback route.", known_decision_refs: [], impact: "AC-5 awaits frontend repair." },
    authority_context: { architecture: { basis, markdown: "APPROVED PLAN BODY ".repeat(1500) },
      passages: Array.from({ length: 24 }, (_, index) => ({ scope: "architecture", passage_id: `PASSAGE-${index}`,
        text: `BOUNDARY-${index} ${"preserve approved ownership ".repeat(90)}` })) },
    ticket_progress: { source_revision: "SOURCE", review_status: { status: "not_started" },
      verification: { status: "missing", retained_attempt: { status: "failed", artifact: { artifact_id: "ARTIFACT-FAILED",
        evidence_ref: "original-artifact.json", commands: [{ kind: "browser", exit_code: 1, argv: ["HISTORICAL COMMAND BODY ".repeat(1200)],
          stdout: "PASS-OUTPUT ".repeat(1200) }] } } } } };
  return { f, job, question, basis, projectRoot: f.base.workspace.projectRoot };
}

test("a large section has one inline directory entry and every linked page remains exactly readable", async (t) => {
  const x = await contextFixture(t);
  x.job.history = Array.from({ length: 120 }, (_, index) => ({ stage: "sprint_leader", summary: `HISTORY-${index} ${"x".repeat(3900)}` }));
  const prepared = await createBlockerPromptContext({ job: x.job, failureEvidence: null, projectRoot: x.projectRoot });
  const directory = JSON.parse(prepared.summary.split("\n").find((line) => line.startsWith("READ-ONLY FULL CONTEXT INDEX: "))
    .slice("READ-ONLY FULL CONTEXT INDEX: ".length));
  assert.equal(directory.filter((entry) => entry.section === "history").length, 1);
  assert(Buffer.byteLength(prepared.summary) < 9000);
  const tools = blockerRecoveryTools({ projectRoot: x.projectRoot, fileService: x.f.base.fileService,
    profile: { role: "architecture_manager", agent_id: "AM" }, task_id: "TASK", job: { ...x.job, prompt_context_refs: prepared.refs } });
  let ref = directory.find((entry) => entry.section === "history"), exact = "", pages = 0;
  while (ref) {
    const file = await tools.registry.read_file.execute({ path: ref.path, offset: 1, limit: 80 });
    assert.equal(file.sha256, ref.sha256);
    const page = JSON.parse(file.content);
    assert.equal(page.index_page, ++pages);
    for (const part of page.parts) {
      const file = await tools.registry.read_file.execute({ path: part.path, offset: 1, limit: 80 });
      assert.equal(file.sha256, part.sha256);
      exact += JSON.parse(file.content).content_lines.join("");
    }
    ref = page.next_index;
  }
  assert(pages > 8);
  assert.deepEqual(JSON.parse(exact), x.job.history);
});

for (const provider of ["codex", "anthropic"]) test(`${provider} AM receives a focused prompt with lookup and native schema instead of duplicated contracts`, async (t) => {
  const x = await contextFixture(t), before = structuredClone(x.job);
  const profile = { agent_id: "AM", role: "architecture_manager", provider, status: "ready", enabled: true };
  let started = 0, released = 0;
  const worker = createBlockerRecoveryAgent({ agentResolver: { resolveAvailable: () => profile },
    agentOccupancy: { claim: async () => ({ claim_id: "C" }), release: async () => { released += 1; } },
    resolveTicketWorkspace: async () => x.f.base.workspace, readFailureEvidence: async () => ({ status: "missing", receipts: [] }),
    gateways: { [provider === "codex" ? "codexSdkGateway" : "claudeSdkGateway"]: { execute: async ({ prompt, options }) => {
      started += 1;
      assert(Buffer.byteLength(prompt) < 45_000, `prompt=${Buffer.byteLength(prompt)}`);
      assert(prompt.includes(x.question));
      assert.match(prompt, /architecture_manager.blocker_decision.v1/);
      assert.match(prompt, /follow next_cursor|Follow next_cursor/);
      assert.equal(prompt.split('"passage_id":"PASSAGE-0"').length - 1, 1);
      assert.doesNotMatch(prompt, /Source-bound decision schema|Payload JSON Schema|Evidence JSON Schema/);
      assert.doesNotMatch(prompt, /APPROVED PLAN BODY|HISTORICAL COMMAND BODY|PASS-OUTPUT|assertPlanSchema|```json/);
      const schema = provider === "codex" ? options.outputSchema : options.outputFormat.schema;
      assert.equal(schema.properties.kind.enum[0], "consultation_response");
      if (provider === "codex") {
        const result = await options.forgeTools.registry.lookup_schema.execute({ schema_id: "architecture_manager.blocker_decision.v1", action: "resolved" });
        assert.equal(result.schema_id, "architecture_manager.blocker_decision.v1");
        assert.equal(result.complete, false);
      } else assert(options.allowedTools.includes("mcp__forge__lookup_schema"));
      return { text: JSON.stringify(x.f.resolution) };
    } } } });
  await worker(x.job, { deadline: Date.now() + 30_000 });
  assert.equal(started, 1); assert.equal(released, 1);
  assert.deepEqual(x.job, before);
});

test("an irreducibly large legacy prompt reports total bytes before invoking the SDK", async (t) => {
  const x = await contextFixture(t);
  delete x.job.request.project_id;
  x.job.request.ticket = { ...x.f.ticket, objective: "LARGE OWNER QUESTION ".repeat(4000) };
  let released = 0;
  const worker = createBlockerRecoveryAgent({ agentResolver: { resolveAvailable: () => ({ agent_id: "AM", role: "architecture_manager", provider: "codex", enabled: true, status: "ready" }) },
    agentOccupancy: { claim: async () => ({ claim_id: "C" }), release: async () => { released += 1; } },
    resolveTicketWorkspace: async () => x.f.base.workspace, readFailureEvidence: async () => null,
    gateways: { codexSdkGateway: { execute: async () => assert.fail("Oversized prompt must not invoke the SDK") } } });
  await assert.rejects(worker(x.job, { deadline: Date.now() + 30_000 }), (error) => {
    assert.equal(error.code, "BLOCKER_PROMPT_TOO_LARGE");
    assert(error.details.prompt_bytes > error.details.max_prompt_bytes);
    assert.equal(error.details.max_prompt_bytes, 64_000);
    assert.equal(error.details.sdk_started, false);
    assert.match(error.message, /Blocker prompt is \d+ bytes after compaction/);
    return true;
  });
  assert.equal(released, 1);
});

test("a completed local prompt overflow retries once after deployment while preserving its AM question", async () => {
  const original = { id: "J", stage: "architecture_manager", status: "reconciliation_required", outcome_reason: "BLOCKER_PROMPT_TOO_LARGE",
    last_error: "Blocker context index exceeds the 64000-byte request budget; no SDK call started.", prompt_context_version: 1,
    history: [], request: { task_id: "TASK" }, resolution: { action: "reconciliation_required", summary: "One owner-ticket route remains unresolved." } };
  const refresh = createBlockerPromptRefresh({ inspect: async () => ({ checkpoint: { last_completed_turn: 56 } }) });
  const job = structuredClone(original);
  assert.equal(await refresh(job), true);
  assert.equal(job.prompt_context_version, 2);
  assert.deepEqual(job.request, original.request); assert.deepEqual(job.resolution, original.resolution);
  assert.equal(job.stage, "architecture_manager"); assert.equal(await refresh(job), false);
  const stopped = structuredClone(original);
  assert.equal(await createBlockerPromptRefresh({ inspect: async () => null })(stopped), false);
  assert.deepEqual(stopped, original);
});

test("restart retries the retained AM stage once after local overflow and Stop prevents that retry", async () => {
  for (const stopped of [false, true]) {
    const f = await blockerRecoveryFixture();
    try {
      await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
      const checkpoint = await f.base.checkpoints.load("TASK");
      await f.recovery.tick();
      if (stopped) await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
      await f.base.store.withLock("blocker.recovery", async () => {
        const ledger = await f.ledger();
        Object.assign(ledger.jobs[0], { status: "reconciliation_required", outcome_reason: "BLOCKER_PROMPT_TOO_LARGE", last_error: "No SDK call started.",
          resolution: { ...ledger.jobs[0].resolution, action: "reconciliation_required" } });
        await f.base.store.save("blocker.recovery", ledger);
      });
      await f.recreate().tick();
      assert.deepEqual(f.calls, stopped ? ["sprint_leader"] : ["sprint_leader", "architecture_manager"]);
      if (!stopped) assert.equal((await f.ledger()).jobs[0].prompt_context_version, 2);
      assert.equal(f.base.invocations, 1);
      assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, checkpoint.last_completed_turn);
    } finally { await f.close(); }
  }
});
