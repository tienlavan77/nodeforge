/** Exercises shared-root source changes with actual File Service locks and ticket
 * journals. Agents may resume and inspect concurrent edits; stale writes, foreign
 * ownership and unrecorded commit source remain enforced at mutation boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket/ticket-change-ledger.js";
import { createTicketExecutionContextStore, prepareTicketExecutionContext } from "../../src/modules/supervisor/ticket/ticket-execution-context.js";
import { ticketSourceChanges } from "../../src/modules/supervisor/ticket/ticket-source-observation.js";
import { coderExchangePrompt } from "../../src/modules/supervisor/coder/coder-agent-exchange.js";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";
import { createReadFileTool, createEditDiffTool } from "../../src/tools/governance/agent-lifecycle-tools.js";

/** Creates real source and retained ticket context without launching an SDK or
 * modifying the developer workspace; cleanup removes all fixture-only storage. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nf-source-observation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = createFileService({ projectRoot: root });
  const logs = [];
  const options = { fileService: files, projectId: "P", projectLogger: (event) => logs.push(event) };
  const ledger = createTicketChangeLedger(options);
  const path = "backend/source.js";
  const contexts = createTicketExecutionContextStore({ fileService: files, projectId: "P", projectRoot: root });
  const workspace = { root_only: true, base_commit: "a".repeat(40), projectRoot: root, executionContexts: contexts,
    changeLedger: { observe: () => ledger.observe("T"), load: () => ledger.load("T"), snapshot: () => ledger.snapshot("T"),
      resume: (input) => ledger.resume("T", input), release: (input) => ledger.release("T", input) } };
  const input = { workspace, taskId: "T", supervisorId: "SUP-T", ticket: { id: "T", project_id: "P", verification_plan: [], execution_policy: { review_gate: "off" } } };
  await files.atomicWrite({ path, content: "base", replace: true });
  await prepareTicketExecutionContext(input);
  await ledger.write({ taskId: "T", path, before: "base", after: "ticket" });
  await contexts.syncManifest("T", await ledger.snapshot("T"));
  await ledger.release("T", { close: false });
  await files.atomicWrite({ path, content: "external", replace: true });
  return { root, files, logs, ledger, path, options, workspace, input };
}

test("source observation preserves live bytes, revision and write ownership across restart", async (t) => {
  const f = await fixture(t);
  const before = await f.ledger.load("T");
  const context = await f.workspace.executionContexts.load("T");
  assert.deepEqual(await prepareTicketExecutionContext(f.input), context);
  await f.ledger.resume("T", { observe_changes: true });
  const observed = await f.ledger.observe("T");
  assert.equal(observed.revision, before.revision);
  assert.deepEqual(observed.entries[f.path].operations, before.entries[f.path].operations);
  assert.equal(observed.entries[f.path].latest_sha, before.entries[f.path].latest_sha);
  assert.equal(await f.files.readFile({ path: f.path }), "external");
  const restarted = createTicketChangeLedger(f.options);
  assert.deepEqual(await restarted.observe("T"), observed);
  assert.equal(f.logs.filter((event) => event.event_name === "ticket.source_changed").length, 1);
  await assert.rejects(restarted.snapshot("T"), { code: "TICKET_SOURCE_CHANGED" });
  assert.equal(ticketSourceChanges(observed)[0].path, f.path);
  await f.ledger.write({ taskId: "B", path: f.path, before: "external", after: "other ticket" });
  await assert.doesNotReject(restarted.resume("T", { observe_changes: true }));
  await assert.rejects(restarted.write({ taskId: "T", path: f.path, before: "other ticket", after: "overwrite" }), { code: "FILE_CLAIM_CONFLICT" });
});

test("fresh-checksum Coder write resolves source drift while stale writes cannot overwrite it", async (t) => {
  const f = await fixture(t);
  await f.ledger.resume("T", { observe_changes: true });
  await assert.rejects(f.ledger.write({ taskId: "T", path: f.path, before: "ticket", after: "wrong" }), { code: "CHECKSUM_MISMATCH" });
  await f.files.atomicWrite({ path: f.path, content: "new external", replace: true });
  await assert.rejects(f.ledger.write({ taskId: "T", path: f.path, before: "external", after: "wrong" }), { code: "CHECKSUM_MISMATCH" });
  await f.ledger.write({ taskId: "T", path: f.path, before: "new external", after: "new external + ticket" });
  const final = await f.ledger.snapshot("T");
  assert.equal(final.entries[f.path].operations[0].after, "ticket");
  assert.equal(final.entries[f.path].operations[1].source_reconciliation.status, "coder_resolution");
  assert.equal(final.entries[f.path].operations.at(-1).before, "new external");
  assert.deepEqual(ticketSourceChanges(final), []);
  await f.ledger.withCommitTransaction("T", async (manifest) => assert.equal(manifest.revision, final.revision));
});

test("deleted and restored files refresh observations without fabricating ticket writes", async (t) => {
  const f = await fixture(t);
  await f.files.deleteFile({ path: f.path });
  assert.equal(ticketSourceChanges(await f.ledger.observe("T"))[0].current_sha256, null);
  await f.files.atomicWrite({ path: f.path, content: "ticket", replace: true });
  assert.deepEqual(ticketSourceChanges(await f.ledger.observe("T")), []);
  assert.equal((await f.ledger.snapshot("T")).revision, 1);
});

test("Coder can explicitly retain current contents through existing edit_diff without a fabricated code change", async (t) => {
  const f = await fixture(t);
  await f.ledger.observe("T");
  const context = { task_id: "T", agent_identity: { role: "coder" }, allowed_file_paths: [f.path] };
  const read = await createReadFileTool({ fileService: f.files }).execute({ path: f.path }, context);
  const edit = createEditDiffTool({ fileService: f.files, changeLedger: { write: (change) => f.ledger.write({ ...change, taskId: "T" }) } });
  await edit.execute({ path: f.path, before_checksum: read.sha256, anchor: "external", replacement: "external" }, context);
  assert.equal(await f.files.readFile({ path: f.path }), "external");
  assert.deepEqual(ticketSourceChanges(await f.ledger.snapshot("T")), []);
  await f.ledger.withCommitTransaction("T", async (manifest) => assert.equal(manifest.entries[f.path].operations[1].source_reconciliation.status, "coder_resolution"));
});

test("interrupted Coder source resolution recovers the journal without duplicate edits", async (t) => {
  const f = await fixture(t);
  let interrupted = false;
  const files = { ...f.files, atomicWrite: async (input) => {
    const result = await f.files.atomicWrite(input);
    if (!interrupted && input.path.endsWith(".json") && JSON.parse(input.content).entries?.[f.path]?.pending?.source_reconciliation) {
      interrupted = true;
      throw Object.assign(new Error("Fixture interrupted resolution journal"), { code: "INTERRUPTED" });
    }
    return result;
  } };
  const crashing = createTicketChangeLedger({ ...f.options, fileService: files });
  await assert.rejects(crashing.write({ taskId: "T", path: f.path, before: "external", after: "external + repair" }), { code: "INTERRUPTED" });
  assert.equal(await f.files.readFile({ path: f.path }), "external");
  const restarted = createTicketChangeLedger(f.options);
  await restarted.write({ taskId: "T", path: f.path, before: "external", after: "external + repair" });
  const manifest = await restarted.snapshot("T");
  assert.equal(manifest.entries[f.path].pending, null);
  assert.equal(manifest.entries[f.path].operations.length, 3);
  assert.equal(manifest.entries[f.path].operations[1].source_reconciliation.status, "coder_resolution");
  assert.equal(await f.files.readFile({ path: f.path }), "external + repair");
});

for (const provider of ["claude", "codex"]) {
  test(`${provider} Coder handoff preserves checkpoint and receives source changes before SDK launch`, async (t) => {
    const f = await fixture(t);
    const profile = { agent_id: "CODER", role: "coder", provider, enabled: true, status: "ready" };
    const checkpoint = { last_completed_turn: 82, agent_id: profile.agent_id, provider, status: "blocked" };
    const expected = { ...await f.workspace.executionContexts.load("T"), source_revision: "OLD", manifest_sha: "OLD-MANIFEST", review_commit_sha: "OLD-COMMIT" };
    let queued;
    const boundary = new Error("Fixture stopped at handoff boundary");
    const integration = createNodeforgeTaskIntegration({ projectRoot: f.root,
      supervisorManager: { startTask: async () => {} }, eventBus: { publish: async () => {} },
      agentResolver: { resolveAvailable: () => profile }, resolveTicketWorkspace: async () => f.workspace,
      handoffQueue: { enqueue: async (request) => { queued = request; throw boundary; } } });
    await assert.rejects(integration.submitTicket({ ticket: f.input.ticket, payload: { retry_source_identity: expected, resume_from: checkpoint } }), (error) => error === boundary);
    assert.equal(queued.payload.resume_from.last_completed_turn, 82);
    assert.equal(queued.selected_agent_id, "CODER");
    assert.notEqual(queued.execution_context.source_revision, expected.source_revision);
    assert.equal(queued.payload.source_changes[0].path, f.path);
    assert.match(coderExchangePrompt(queued), /CURRENT SOURCE CHANGES/);
    assert.match(coderExchangePrompt(queued), /fresh whole-file checksum/);
    assert.equal(await f.files.readFile({ path: f.path }), "external");
  });
}
