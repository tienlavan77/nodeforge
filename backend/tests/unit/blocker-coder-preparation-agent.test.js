// Verifies provider-neutral read-only Coder preparation uses existing Forge tools and rejects unsafe or stale dossiers.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createBlockerRecoveryAgent } from "../../src/modules/supervisor/blocker-recovery-agent.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";

const readTools = ["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff"];

for (const provider of ["openai", "codex", "claude"]) {
  test(`${provider} preparation has read tools and checkpoint context, without mutation or completion tools`, async () => {
    const fixture = await blockerRecoveryFixture();
    let released = 0;
    try {
      const gateway = { execute: async ({ agent, prompt, options }) => {
        assert.equal(agent.role, "coder");
        assert.match(prompt, /READ-ONLY CODER PREPARATION/);
        assert.match(prompt, /preserve-initialization-question/);
        assert.match(prompt, /last_completed_turn/);
        if (provider === "claude") {
          assert.deepEqual(options.allowedTools, readTools.map((tool) => `mcp__forge__${tool}`));
        } else {
          assert.deepEqual(Object.keys(options.forgeTools.registry), readTools);
          await options.forgeTools.registry.read_file.execute({ path: fixture.evidence.path });
        }
        return { text: JSON.stringify({ action: "architecture_required", summary: "Need a safer alternative.", guidance: "Preserve initialization." }) };
      } };
      const worker = createBlockerRecoveryAgent({
        agentResolver: { resolveAvailable: (role) => ({ agent_id: "CODER", role, provider, enabled: true, status: "ready" }) },
        agentOccupancy: { claim: async ({ role }) => { assert.equal(role, "coder"); return { claim_id: "PREP" }; }, release: async () => { released += 1; } },
        resolveTicketWorkspace: async () => fixture.base.workspace,
        readFailureEvidence: async () => ({ status: "captured", receipts: [] }),
        gateways: { openaiSdkGateway: gateway, claudeSdkGateway: gateway }
      });
      const result = await worker({ id: "JOB", stage: "coder", request: { task_id: "TASK", ticket: fixture.ticket }, history: [],
        coder_checkpoint: { last_completed_turn: 12 }, coder_exchange: { request_id: "REQUEST", request: { questions: ["preserve-initialization-question"] } } }, { deadline: Date.now() + 2000 });
      assert.equal(result.action, "architecture_required");
      assert.equal(released, 1);
      assert.equal(fixture.base.invocations, 0);
    } finally { await fixture.close(); }
  });
}

test("Coder dossiers enforce file budget, source scope, hashes and request binding", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const job = { stage: "coder", coder_exchange: { request_id: "REQUEST" }, request: { ticket: { ...fixture.ticket, file_budget: 1 } } };
    const options = { job, plan: {}, fileService: fixture.base.fileService, projectRoot: fixture.base.workspace.projectRoot };
    const patch = { path: fixture.evidence.path, sha256: fixture.evidence.sha256, rationale: "Preserve initialization.",
      patch: `--- a/${fixture.evidence.path}\n+++ b/${fixture.evidence.path}\n@@ -1 +1,2 @@\n export const approvedHandler = true;\n+export const selected = true;\n` };
    const value = { action: "candidate_prepared", summary: "Proposed scoped change.", candidate: { changes: [patch], verification_steps: ["Run focused routing tests."] } };
    for (const changes of [
      [{ ...patch, sha256: "0".repeat(64) }], [patch, { ...patch, path: "backend/other.js" }],
      [{ ...patch, path: "../outside.js", patch: "--- a/../outside.js\n+++ b/../outside.js\n@@ -1 +1 @@\n-old\n+new\n" }],
      [{ ...patch, patch: "invalid" }]
    ]) await assert.rejects(validateBlockerDisposition({ ...value, candidate: { ...value.candidate, changes } }, options));
    const result = await validateBlockerDisposition(value, options);
    assert.equal(result.candidate.request_id, "REQUEST");
    assert.match(result.candidate.sha256, /^[a-f0-9]{64}$/);
    delete job.coder_exchange;
    await assert.rejects(validateBlockerDisposition(value, options), { code: "BLOCKER_DISPOSITION_INVALID" });
    job.stage = "sprint_leader";
    job.coder_exchange = { request_id: "REQUEST" };
    await assert.rejects(validateBlockerDisposition(fixture.resolution, options), (error) => error.validation_errors[0].reason === "technical_result_incomplete");
    const handoff = { findings: ["No candidate is needed to continue the approved handler."], implementation_steps: ["Complete the handler from the retained checkpoint."],
      verification_steps: ["Run focused handler tests."], admission: { status: "within_existing_permissions", rationale: "Existing mutation gates remain enforced." } };
    assert.equal((await validateBlockerDisposition({ ...fixture.resolution, technical_result: handoff }, options)).action, "resolved");
  } finally { await fixture.close(); }
});
