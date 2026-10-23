// Tests compact recovery prompts and exact on-demand context delivery without weakening authority or runtime file protections.
import assert from "node:assert/strict";
import test from "node:test";
import { rm, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createBlockerPromptContext, createBlockerPromptRefresh } from "../../src/modules/supervisor/blocker-prompt-context.js";
import { blockerRecoveryTools } from "../../src/modules/supervisor/blocker-recovery-tools.js";
import { createBlockerRecoveryAgent } from "../../src/modules/supervisor/blocker-recovery-agent.js";

// Creates trusted assignment identities and long diagnostic text whose exact tail must remain available to both provider adapters.
async function fixture(t) {
  const f = await blockerRecoveryFixture();
  t.after(() => f.close());
  const job = { id: "J", stage: "sprint_leader", history: [], request: { project_id: "P", task_id: "TASK", payload: { execution_id: "E" },
    execution_context: { source_revision: "SOURCE" }, ticket: f.ticket },
    contract_context: `AM CONTRACT ${"điều kiện ".repeat(900)}DO NOT broaden WebSearch.`,
    ticket_progress: { source_revision: "SOURCE", criteria: [{ criterion_id: "AC-1", criterion: f.ticket.acceptance_criteria[0], checks: [], verification: "unverified" }],
      verification: { status: "missing", historical_checks: [{ check_id: "CHECK-OLD", evidence_ref: "original-receipt.json", diagnostic_only: true,
        source_revision: "OLD", environment: { sha256: "ENV" }, stdout: `FAILURE-OUTPUT-${"x".repeat(10000)}` }] }, architecture_decision: { guidance: "duplicate AM contract" } } };
  const projectRoot = f.base.workspace.projectRoot;
  // Uses the actual shared Forge registry so context copies cannot depend on provider-specific native read tools.
  const tools = (prepared, role = "sprint_leader", assigned = job) => blockerRecoveryTools({ projectRoot, fileService: f.base.fileService,
    profile: { role, agent_id: "A" }, task_id: "TASK", job: { ...assigned, prompt_context_refs: prepared.refs } });
  return { f, job, projectRoot, tools, prepare: () => createBlockerPromptContext({ job, failureEvidence: null, projectRoot }) };
}

test("SL and AM recover every exact context part, including negations beyond inline excerpts", async (t) => {
  const x = await fixture(t), before = structuredClone(x.job), prepared = await x.prepare();
  assert.deepEqual(x.job, before);
  assert.equal(prepared.job.contract_context.read_full_section_before_deciding, true);
  assert.doesNotMatch(JSON.stringify(prepared.job.ticket_progress), /FAILURE-OUTPUT/);
  assert.equal(prepared.job.ticket_progress.verification.historical_checks[0].evidence_ref, "original-receipt.json");
  assert.equal(prepared.job.ticket_progress.architecture_decision, undefined);
  assert.equal(prepared.job.ticket_progress.criteria[0].definition, "request.ticket.acceptance_criteria[0]");
  for (const role of ["sprint_leader", "architecture_manager"]) {
    const tools = x.tools(prepared, role);
    let exact = "";
    for (const ref of prepared.refs.filter((entry) => entry.section === "contract_context" && entry.part > 0)) {
      const file = await tools.registry.read_file.execute({ path: ref.path, offset: 1, limit: 80 });
      assert.equal(file.sha256, ref.sha256);
      assert(Buffer.byteLength(file.content) < 20_000);
      exact += JSON.parse(file.content).content_lines.join("");
      assert.match((await tools.registry.read_lines.execute({ path: ref.path, start_line: 1, end_line: 80 })).stdout, /content_lines/);
    }
    assert.equal(JSON.parse(exact), x.job.contract_context);
  }
  assert.deepEqual((await x.prepare()).refs, prepared.refs);
});

test("context read grants reject unissued snapshots, changed bytes, other assignments and symlinks", async (t) => {
  const x = await fixture(t), prepared = await x.prepare();
  const ref = prepared.refs.find((entry) => entry.part > 0), tools = x.tools(prepared);
  const unissued = x.tools({ refs: [] });
  await assert.rejects(unissued.registry.read_file.execute({ path: ref.path }), { code: "FILE_ROLE_FORBIDDEN" });
  for (const assigned of [{ ...x.job, id: "OTHER" }, { ...x.job, request: { ...x.job.request, project_id: "OTHER" } },
    { ...x.job, request: { ...x.job.request, payload: { execution_id: "OTHER" } } },
    { ...x.job, request: { ...x.job.request, execution_context: { source_revision: "OTHER" } } }]) {
    await assert.rejects(x.tools(prepared, "sprint_leader", assigned).registry.read_file.execute({ path: ref.path }), { code: "BLOCKER_CONTEXT_STALE" });
  }
  const original = await readFile(join(x.projectRoot, ref.path), "utf8");
  await x.f.base.fileService.atomicWrite({ path: ref.path, content: original.replace('"SOURCE"', '"OTHER"'), replace: true });
  await assert.rejects(tools.registry.read_file.execute({ path: ref.path }), { code: "BLOCKER_CONTEXT_STALE" });
  await rm(join(x.projectRoot, ref.path));
  await symlink(join(x.projectRoot, x.f.evidence.path), join(x.projectRoot, ref.path));
  await assert.rejects(tools.registry.read_file.execute({ path: ref.path }), { code: "FILE_ROLE_FORBIDDEN" });
});

test("SDK receives compact context while exact denied-operation evidence remains readable through its Forge tools", async (t) => {
  const x = await fixture(t);
  const denial = `DENIED ${"historical attempted change ".repeat(4000)}DO NOT RETRY`;
  let promptBytes = 0;
  const profile = { agent_id: "SL", role: "sprint_leader", provider: "codex", enabled: true, status: "ready" };
  const worker = createBlockerRecoveryAgent({ agentResolver: { resolveAvailable: () => profile },
    agentOccupancy: { claim: async () => ({ claim_id: "C" }), release: async () => {} }, resolveTicketWorkspace: async () => x.f.base.workspace,
    readFailureEvidence: async () => ({ status: "captured", receipts: [{ error: { message: denial } }] }),
    gateways: { codexSdkGateway: { execute: async ({ prompt, options }) => {
      promptBytes = Buffer.byteLength(prompt);
      assert.match(prompt, /READ-ONLY FULL CONTEXT INDEX/);
      assert.match(prompt, /Display excerpts are incomplete and grant no authority/);
      assert.doesNotMatch(prompt, /FAILURE-OUTPUT/);
      const line = prompt.split("\n").find((value) => value.startsWith("READ-ONLY FULL CONTEXT INDEX: "));
      const indexes = JSON.parse(line.slice("READ-ONLY FULL CONTEXT INDEX: ".length));
      let exact = "";
      for (const index of indexes.filter((entry) => entry.section === "failure_evidence")) {
        const body = JSON.parse((await options.forgeTools.registry.read_file.execute({ path: index.path, offset: 1, limit: 80 })).content);
        for (const ref of body.parts) exact += JSON.parse((await options.forgeTools.registry.read_file.execute({ path: ref.path, offset: 1, limit: 80 })).content).content_lines.join("");
      }
      assert.equal(JSON.parse(exact).receipts[0].error.message, denial);
      return { text: JSON.stringify(x.f.resolution) };
    } } } });
  const result = await worker(x.job, { deadline: Date.now() + 30_000 });
  assert.equal(result.action, "resolved");
  assert(promptBytes < 45_000, `prompt=${promptBytes}`);
});

test("known terminal prompt failure retries the existing AM consultation once and never replays unknown provider failures", async () => {
  const original = { id: "J", stage: "architecture_manager", outcome_reason: "CONFIGURATION_ERROR", history: [], request: { task_id: "TASK" },
    resolution: { action: "architecture_required", guidance: "Answer the retained SL question." },
    last_error: "Claude SDK request failed: Claude Code returned an error result: Prompt is too long · automatic compaction failed: summarization produced empty response" };
  const refresh = createBlockerPromptRefresh({ inspect: async () => ({ checkpoint: { last_completed_turn: 82 } }) });
  const job = structuredClone(original);
  assert.equal(await refresh(job), true);
  assert.deepEqual(job.request, original.request); assert.deepEqual(job.resolution, original.resolution);
  assert.equal(job.stage, "architecture_manager"); assert.equal(await refresh(job), false);
  for (const change of [{ last_error: "Provider interrupted; unknown outcome" }, { outcome_reason: "BLOCKER_PROVIDER_UNKNOWN" }, { last_error: "503 unavailable" }])
    assert.equal(await refresh({ ...structuredClone(original), ...change }), false);
  assert.equal(await createBlockerPromptRefresh({ inspect: async () => null })(structuredClone(original)), false);
});

test("oversized finding context uses the smaller indexed request before reaching either SDK", async (t) => {
  const x = await fixture(t);
  x.job.ticket_progress.review_findings = Array.from({ length: 16 }, (_, index) => ({ finding_id: `REV-${index + 1}`,
    details: Object.fromEntries(Array.from({ length: 20 }, (_, field) => [`detail_${field}`, "q".repeat(790)])) }));
  let bytes = 0;
  const profile = { agent_id: "SL", role: "sprint_leader", provider: "codex", enabled: true, status: "ready" };
  const worker = createBlockerRecoveryAgent({ agentResolver: { resolveAvailable: () => profile },
    agentOccupancy: { claim: async () => ({ claim_id: "C" }), release: async () => {} }, resolveTicketWorkspace: async () => x.f.base.workspace,
    readFailureEvidence: async () => ({ status: "missing", receipts: [] }),
    gateways: { codexSdkGateway: { execute: async ({ prompt }) => {
      bytes = Buffer.byteLength(prompt);
      assert.match(prompt, /^AGENT EXCHANGE v1/);
      assert.doesNotMatch(prompt, /detail_19/);
      return { text: JSON.stringify(x.f.resolution) };
    } } } });
  await worker(x.job, { deadline: Date.now() + 30_000 });
  assert(bytes < 64_000, `prompt=${bytes}`);
});

test("production recovery honors Stop before retrying a known terminal prompt failure", async () => {
  for (const stopped of [false, true]) {
    const f = await blockerRecoveryFixture({ investigate: async (_job, resolution) => resolution });
    try {
      await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
      const checkpoint = await f.base.checkpoints.load("TASK");
      if (stopped) await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
      await f.base.store.withLock("blocker.recovery", async () => {
        const ledger = await f.ledger();
        Object.assign(ledger.jobs[0], { status: "reconciliation_required", outcome_reason: "CONFIGURATION_ERROR",
          last_error: "Claude Code returned an error result: Prompt is too long · automatic compaction failed" });
        await f.base.store.save("blocker.recovery", ledger);
      });
      f.recreate(); await f.recovery.tick();
      assert.deepEqual(f.calls, stopped ? [] : ["sprint_leader"]);
      assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, checkpoint.last_completed_turn);
      assert.equal(f.base.invocations, 1);
    } finally { await f.close(); }
  }
});
