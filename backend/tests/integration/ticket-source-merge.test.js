// Exercises concurrent ticket source reconciliation with real file locks, journals and restart recovery.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket/ticket-change-ledger.js";
import { planTicketSourceMerge } from "../../src/modules/supervisor/ticket/ticket-source-merge-plan.js";

// Creates isolated project services and registers cleanup so each test uses production journal and ownership behavior.
async function fixture(t, base = "one\ntwo\nthree\n") {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-reconcile-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = createFileService({ projectRoot: root });
  const events = [];
  const options = { fileService: files, projectId: "PROJECT-TEST", projectLogger: (event) => events.push(event) };
  const ledger = createTicketChangeLedger(options);
  const path = "backend/source.js", taskId = "TICKET-A";
  await files.atomicWrite({ path, content: base, replace: true });
  return { files, events, ledger, path, taskId, options };
}

test("adjacent independent edits merge without overwriting concurrent work and remain idempotent across restart", async (t) => {
  const { files, ledger, events, path, taskId, options } = await fixture(t);
  await ledger.write({ taskId, path, before: "one\ntwo\nthree\n", after: "ONE\ntwo\nthree\n" });
  await files.atomicWrite({ path, content: "one\nTWO\nthree\n", replace: true });
  const merged = await ledger.reconcile(taskId);
  assert.equal(await files.readFile({ path }), "ONE\nTWO\nthree\n");
  assert.equal(merged.revision, 2);
  assert.equal(merged.entries[path].operations[0].after, "ONE\ntwo\nthree\n");
  assert.equal(merged.entries[path].operations[1].source_reconciliation.status, "merged");
  assert.equal(merged.entries[path].source_reconciliation.live_sha, merged.entries[path].operations[1].recovery_before_sha);
  const restarted = createTicketChangeLedger(options);
  assert.deepEqual(await restarted.reconcile(taskId), await restarted.snapshot(taskId));
  assert.equal((await restarted.snapshot(taskId)).revision, 2);
  assert.equal(events.at(-1).event_name, "ticket.source_reconciled");
});

test("overlap preserves live source and supplies a source-bound Coder repair at the retained journal", async (t) => {
  const { files, ledger, path, taskId } = await fixture(t);
  await ledger.write({ taskId, path, before: "one\ntwo\nthree\n", after: "TICKET\ntwo\nthree\n" });
  await ledger.release(taskId, { close: false });
  await files.atomicWrite({ path, content: "CONCURRENT\ntwo\nthree\n", replace: true });
  const observed = await ledger.reconcile(taskId);
  assert.equal(observed.revision, 1);
  assert.equal(observed.entries[path].source_reconciliation.status, "conflict");
  assert.equal(observed.entries[path].source_reconciliation.conflicts[0].base_start_line, 1);
  await assert.rejects(ledger.snapshot(taskId), { code: "TICKET_SOURCE_CHANGED" });
  await ledger.resume(taskId);
  const before = await files.readFile({ path });
  assert.equal(before, "CONCURRENT\ntwo\nthree\n");
  await ledger.write({ taskId, path, before, after: "CONCURRENT + TICKET\ntwo\nthree\n" });
  const repaired = await ledger.snapshot(taskId);
  assert.equal(repaired.revision, 3);
  assert.equal(repaired.entries[path].operations[1].source_reconciliation.status, "coder_resolution");
  assert.equal(repaired.entries[path].operations[2].before, before);
});

test("stale conflict evidence and foreign claims cannot authorize reconciliation", async (t) => {
  const { files, ledger, path, taskId } = await fixture(t, "base");
  await ledger.write({ taskId, path, before: "base", after: "ticket" });
  await files.atomicWrite({ path, content: "external", replace: true });
  await ledger.reconcile(taskId);
  await files.atomicWrite({ path, content: "new external", replace: true });
  await assert.rejects(ledger.write({ taskId, path, before: "external", after: "repair" }), { code: "CHECKSUM_MISMATCH" });
  await ledger.write({ taskId, path, before: "new external", after: "repair" });
  await ledger.release(taskId, { close: false });
  await ledger.write({ taskId: "TICKET-B", path, before: "repair", after: "other owner" });
  await assert.rejects(ledger.write({ taskId, path, before: "other owner", after: "overwrite" }), { code: "FILE_CLAIM_CONFLICT" });
  await assert.rejects(ledger.reconcile(taskId), { code: "FILE_CLAIM_CONFLICT" });
});

test("interrupted reconciled write recovers its historical before hash and observed live hash", async (t) => {
  const { files, ledger, path, taskId, options } = await fixture(t);
  await ledger.write({ taskId, path, before: "one\ntwo\nthree\n", after: "ONE\ntwo\nthree\n" });
  await files.atomicWrite({ path, content: "one\nTWO\nthree\n", replace: true });
  let interrupted = true;
  const crashingFiles = { ...files, atomicWrite: async (input) => {
    const result = await files.atomicWrite(input);
    if (input.path === path && interrupted) { interrupted = false; throw Object.assign(new Error("simulated crash"), { code: "CRASH" }); }
    return result;
  } };
  await assert.rejects(createTicketChangeLedger({ ...options, fileService: crashingFiles }).reconcile(taskId), { code: "CRASH" });
  const recovered = await createTicketChangeLedger(options).snapshot(taskId);
  assert.equal(recovered.entries[path].pending, null);
  assert.equal(recovered.revision, 2);
  assert.equal(recovered.entries[path].operations.at(-1).after, "ONE\nTWO\nthree\n");
});

test("source mutation during merge planning refuses to overwrite newer live bytes", async (t) => {
  const { files, ledger, path, taskId, options } = await fixture(t);
  await ledger.write({ taskId, path, before: "one\ntwo\nthree\n", after: "ONE\ntwo\nthree\n" });
  await files.atomicWrite({ path, content: "one\nTWO\nthree\n", replace: true });
  let reads = 0;
  const racingFiles = { ...files, readFile: async (input) => {
    if (input.path === path && ++reads === 2) await files.atomicWrite({ path, content: "newer source", replace: true });
    return files.readFile(input);
  } };
  await assert.rejects(createTicketChangeLedger({ ...options, fileService: racingFiles }).reconcile(taskId), { code: "TICKET_SOURCE_CHANGED" });
  assert.equal(await files.readFile({ path }), "newer source");
});

for (const scenario of [
  { name: "identical edits", base: "a\nb\n", ticket: "A\nb\n", live: "A\nb\n", status: "identical", content: "A\nb\n" },
  { name: "shared identical and independent edits", base: "a\nb\nc\n", ticket: "A\nb\nc\n", live: "A\nb\nC\n", status: "merged", content: "A\nb\nC\n" },
  { name: "reverted ticket edit", base: "a", ticket: "b", live: "a", status: "merged", content: "b" },
  { name: "concurrent creation", base: null, ticket: "a", live: "b", status: "conflict" },
  { name: "deletion against modification", base: "a", ticket: null, live: "b", status: "conflict" },
  { name: "final newline", base: "a\nb", ticket: "A\nb", live: "a\nB", status: "merged", content: "A\nB" },
  { name: "divergent insertions", base: "a\nb", ticket: "a\nx\nb", live: "a\ny\nb", status: "conflict" }
]) test(`merge plan handles ${scenario.name}`, async () => {
  const result = await planTicketSourceMerge(scenario);
  assert.equal(result.status, scenario.status);
  if (scenario.content !== undefined) assert.equal(result.content, scenario.content);
});

test("a retained commit transaction prevents source adoption until commit recovery settles", async (t) => {
  const { files, ledger, path, taskId } = await fixture(t);
  await ledger.write({ taskId, path, before: "one\ntwo\nthree\n", after: "ONE\ntwo\nthree\n" });
  await ledger.prepareCommit(taskId, 1, "a".repeat(40));
  await files.atomicWrite({ path, content: "one\nTWO\nthree\n", replace: true });
  const retained = await ledger.reconcile(taskId);
  assert.equal(retained.revision, 1);
  assert.equal(retained.entries[path].source_reconciliation, undefined);
  assert.equal(await files.readFile({ path }), "one\nTWO\nthree\n");
  await assert.rejects(ledger.snapshot(taskId), { code: "TICKET_SOURCE_CHANGED" });
});
