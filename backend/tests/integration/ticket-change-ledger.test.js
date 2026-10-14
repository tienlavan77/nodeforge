// Verifies durable ticket file claims across independent Forge File Service clients.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket-change-ledger.js";
import { createHash } from "node:crypto";

test("two ticket ledgers racing for one root file produce one owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-ticket-claim-"));
  const path = "backend/src/shared.js";
  const options = { projectId: "PROJECT-TEST" };
  const firstFiles = createFileService({ projectRoot: root });
  const secondFiles = createFileService({ projectRoot: root });
  try {
    await firstFiles.atomicWrite({ path, content: "// shared\n", replace: true });
    const first = createTicketChangeLedger({ ...options, fileService: firstFiles });
    const second = createTicketChangeLedger({ ...options, fileService: secondFiles });
    const results = await Promise.allSettled([
      first.write({ taskId: "TICKET-A", path, before: "// shared\n", after: "// ticket A\n" }),
      second.write({ taskId: "TICKET-B", path, before: "// shared\n", after: "// ticket B\n" })
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "FILE_CLAIM_CONFLICT").length, 1);
    const owner = results[0].status === "fulfilled" ? "TICKET-A" : "TICKET-B";
    const restarted = createTicketChangeLedger({ ...options, fileService: createFileService({ projectRoot: root }) });
    const snapshot = await restarted.snapshot(owner);
    assert.deepEqual(Object.keys(snapshot.entries), [path]);
    assert.equal(snapshot.revision, 1);
    assert.match(await readFile(join(root, path), "utf8"), /ticket [AB]/);
    const before = await readFile(join(root, path), "utf8");
    const after = "// resumed write\n";
    // Hashes the interrupted write's expected source content.
    const sha = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
    // Locates the durable ticket manifest for crash simulation.
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    const manifestPath = `.forge/runtime/ticket-changes/${digest("PROJECT-TEST")}/tickets/${digest(owner)}.json`;
    snapshot.entries[path].pending = { id: "INTERRUPTED-WRITE", before_sha: sha(before), after_sha: sha(after), before, after };
    await firstFiles.atomicWrite({ path: manifestPath, content: JSON.stringify(snapshot), replace: true });
    await firstFiles.atomicWrite({ path, content: after, replace: true });
    const recovered = await restarted.snapshot(owner);
    assert.equal(recovered.revision, 2);
    assert.equal(recovered.entries[path].pending, null);
    assert.equal(recovered.entries[path].operations.at(-1).id, "INTERRUPTED-WRITE");
    assert.equal((await restarted.write({ taskId: owner, path, before, after, operationId: "INTERRUPTED-WRITE" })).repeated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ticket reapplies a reverted file change instead of claiming a stale repeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-ticket-reapply-"));
  const path = "backend/src/shared.js";
  const original = "// original\n";
  const changed = "// changed\n";
  const files = createFileService({ projectRoot: root });
  try {
    await files.atomicWrite({ path, content: original, replace: true });
    const ledger = createTicketChangeLedger({ projectId: "PROJECT-TEST", fileService: files });
    await ledger.write({ taskId: "TICKET-A", path, before: original, after: changed });
    await ledger.write({ taskId: "TICKET-A", path, before: changed, after: original });
    const result = await ledger.write({ taskId: "TICKET-A", path, before: original, after: changed });
    assert.equal(result.repeated, undefined);
    assert.equal(result.revision, 3);
    assert.equal(await readFile(join(root, path), "utf8"), changed);
    assert.equal((await ledger.write({ taskId: "TICKET-A", path, before: original, after: changed })).repeated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["resume", "write", "repeat"]) {
  test(`failed ticket releases resources and ${mode} reacquires the same claim for commit`, async () => {
    const root = await mkdtemp(join(tmpdir(), "nodeforge-ticket-reclaim-"));
    const path = "ui/panel.js";
    const files = createFileService({ projectRoot: root });
    const logs = [];
    const ledger = createTicketChangeLedger({ fileService: files, projectId: "PROJECT-TEST", projectLogger: (event) => logs.push(event) });
    try {
      await files.atomicWrite({ path, content: "original", replace: true });
      await ledger.write({ taskId: "TICKET-A", path, before: "original", after: "changed" });
      const original = await ledger.snapshot("TICKET-A");
      await ledger.release("TICKET-A", { close: false });
      assert.equal(await files.readFile({ path }), "changed");
      assert.equal((await ledger.load("TICKET-A")).state, "active");
      if (mode === "resume") await ledger.resume("TICKET-A");
      if (mode === "write") await ledger.write({ taskId: "TICKET-A", path, before: "changed", after: "fixed" });
      if (mode === "repeat") assert.equal((await ledger.write({ taskId: "TICKET-A", path, before: "original", after: "changed" })).repeated, true);
      const restarted = createTicketChangeLedger({ fileService: createFileService({ projectRoot: root }), projectId: "PROJECT-TEST" });
      await restarted.withCommitTransaction("TICKET-A", async (manifest) => {
        assert.equal(manifest.entries[path].claim_id, original.entries[path].claim_id);
        assert.equal(manifest.revision, mode === "write" ? 2 : 1);
      });
      assert.equal(logs.find((event) => event.event_name === "ticket.file_claims_released").payload.resumable, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("released ticket cannot steal another ticket's file or hide source drift during resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-ticket-reclaim-conflict-"));
  const path = "ui/panel.js";
  const files = createFileService({ projectRoot: root });
  const ledger = createTicketChangeLedger({ fileService: files, projectId: "PROJECT-TEST" });
  try {
    await files.atomicWrite({ path, content: "original", replace: true });
    await ledger.write({ taskId: "TICKET-A", path, before: "original", after: "changed" });
    await ledger.release("TICKET-A", { close: false });
    await files.atomicWrite({ path, content: "outside change", replace: true });
    await assert.rejects(ledger.resume("TICKET-A"), { code: "TICKET_SOURCE_CHANGED" });
    await ledger.write({ taskId: "TICKET-B", path, before: "outside change", after: "ticket B" });
    await assert.rejects(ledger.resume("TICKET-A"), { code: "FILE_CLAIM_CONFLICT" });
    await ledger.release("TICKET-A", { close: false });
    await ledger.withCommitTransaction("TICKET-B", async () => {});
    assert.equal(await files.readFile({ path }), "ticket B");
  } finally { await rm(root, { recursive: true, force: true }); }
});
