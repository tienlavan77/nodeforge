// Reproduces root-only blocker investigation failures using the production committed Reviewer file adapter.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createTicketCommitFileService } from "../../src/modules/supervisor/ticket-commit-file-service.js";

// Models production root-only source separation without substituting a writable fake for Reviewer files.
function useRootWorkspace(fixture) {
  const workspace = fixture.base.workspace;
  workspace.root_only = true;
  workspace.path = workspace.projectRoot;
  workspace.worktreeFileService = createTicketCommitFileService({ taskId: "TASK", projectRoot: workspace.projectRoot,
    executionContexts: workspace.executionContexts });
  assert.equal(workspace.worktreeFileService.atomicWrite, undefined);
}

test("root-only SL and Architecture inspect live source and resume before any Reviewer commit exists", async () => {
  const fixture = await blockerRecoveryFixture();
  const roles = [];
  try {
    useRootWorkspace(fixture);
    fixture.recreate({ investigate: undefined,
      agentResolver: { resolveAvailable: (role) => ({ agent_id: role, role, provider: "openai", enabled: true, status: "ready" }) },
      gateways: { openaiSdkGateway: { execute: async ({ agent, options }) => {
        roles.push(agent.role);
        const tools = options.forgeTools.registry;
        assert.deepEqual(Object.keys(tools), ["read_source", "list_files"]);
        const result = await tools.read_source.execute({ path: fixture.evidence.path });
        assert.equal(result.sha256, fixture.evidence.sha256);
        assert((await tools.list_files.execute({ glob: "backend/src/*.js" })).paths.includes(fixture.evidence.path));
        await assert.rejects(tools.read_source.execute({ path: "../outside" }), { code: "FILE_ROLE_FORBIDDEN" });
        return { text: JSON.stringify(agent.role === "sprint_leader" ? { action: "architecture_required", summary: "Verify the existing architecture." } : fixture.resolution) };
      } } } });
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.deepEqual(roles, ["sprint_leader", "architecture_manager"]);
    assert.equal(fixture.base.invocations, 2);
    assert.equal(fixture.base.integrations, 1);
    assert.equal((await fixture.ledger()).jobs[0].status, "resumed");
    await assert.rejects(fixture.base.workspace.worktreeFileService.readFile({ path: fixture.evidence.path }), { code: "REVIEW_COMMIT_MISSING" });
  } finally { await fixture.close(); }
});

test("root-only contract preflight checks the live approved source rather than a missing Reviewer commit", async () => {
  const fixture = await blockerRecoveryFixture({ reason: "CONTRACT_DECISION_REQUIRED", ticket: { execution_policy: {
    requires_existing_contract: true, contract_evidence: [{ path: "backend/src/handler.js",
      sha256: createHash("sha256").update("export const approvedHandler = true;\n").digest("hex"),
      authority_quote: "Reuse backend/src/handler.js under the existing approved contract." }] } } });
  try {
    useRootWorkspace(fixture);
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    assert.equal(fixture.base.invocations, 1);
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal(fixture.base.invocations, 2);
    assert.equal(fixture.base.integrations, 1);
  } finally { await fixture.close(); }
});

test("adapter failures are reported as technical reconciliation, not a concluded owner policy decision", async () => {
  const fixture = await blockerRecoveryFixture();
  const logs = [];
  try {
    fixture.recreate({ projectLogger: (entry) => logs.push(entry), investigate: async () => {
      throw Object.assign(new Error("Adapter preparation failed before provider dispatch"), { code: "CONFIGURATION_ERROR" });
    } });
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    const notification = logs.find((entry) => entry.event_name === "ticket.blocker_reconciliation_required");
    assert.match(notification.message, /technical reconciliation/);
    assert.equal(notification.payload.reason, "CONFIGURATION_ERROR");
    assert.doesNotMatch(notification.message, /needs a bounded owner decision/);
    assert.equal((await fixture.ledger()).jobs[0].history.length, 0);
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

test("root-only recovery rejects changed live evidence before checkpoint resume", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    useRootWorkspace(fixture);
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "resume_pending");
    await fixture.base.fileService.atomicWrite({ path: fixture.evidence.path, content: "export const changed = true;\n", replace: true });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.base.integrations, 0);
    assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
    assert.match((await fixture.ledger()).jobs[0].last_error, /stale/);
  } finally { await fixture.close(); }
});
