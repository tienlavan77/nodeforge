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

// Ledger digest helper shared by the foundation-successor rebase cases below.
const ledgerKey = (value) => createHash("sha256").update(value).digest("hex");
const ledgerManifestPath = (taskId) => `.forge/runtime/ticket-changes/${ledgerKey("PROJECT-TEST")}/tickets/${ledgerKey(taskId)}.json`;
const ledgerClaimPath = (path) => `.forge/runtime/ticket-changes/${ledgerKey("PROJECT-TEST")}/claims/${ledgerKey(path)}.json`;

// Prepares a source ticket whose released baseline drifted through one governed successor write.
async function driftScenario(root) {
  const path = "backend/src/project-lifecycle.js";
  const files = createFileService({ projectRoot: root });
  const ledger = createTicketChangeLedger({ fileService: files, projectId: "PROJECT-TEST" });
  await files.atomicWrite({ path, content: "base", replace: true });
  await ledger.write({ taskId: "TICKET-SOURCE", path, before: "base", after: "source v1" });
  await ledger.release("TICKET-SOURCE", { close: false });
  await ledger.write({ taskId: "TICKET-FOUNDATION", path, before: "source v1", after: "foundation v2" });
  const successor = await ledger.load("TICKET-FOUNDATION");
  successor.commits = { [successor.revision]: "7fe94fad0e8b9b1f70e838b2d902b2e6e1d20e46" };
  await files.atomicWrite({ path: ledgerManifestPath("TICKET-FOUNDATION"), content: JSON.stringify(successor), replace: true });
  await ledger.release("TICKET-FOUNDATION", { close: true });
  return { files, ledger, path };
}

test("approved closed successor rebases the released baseline and preserves commit eligibility", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-ticket-rebase-"));
  try {
    const { files, ledger, path } = await driftScenario(root);
    await assert.rejects(ledger.resume("TICKET-SOURCE"), { code: "TICKET_SOURCE_CHANGED" });
    const logs = [];
    const observed = createTicketChangeLedger({ fileService: files, projectId: "PROJECT-TEST", projectLogger: (event) => logs.push(event) });
    await observed.resume("TICKET-SOURCE", { integrated_successors: ["TICKET-FOUNDATION"] });
    const manifest = await observed.load("TICKET-SOURCE");
    assert.equal(manifest.entries[path].latest_sha, `sha256:${createHash("sha256").update("foundation v2").digest("hex")}`);
    const rebase = manifest.entries[path].operations.at(-1);
    assert.equal(rebase.integrated_from, "TICKET-FOUNDATION");
    assert.equal(rebase.status, "completed");
    assert.equal(rebase.after, "foundation v2");
    assert.equal(manifest.revision, rebase.revision);
    assert.equal(logs.find((event) => event.event_name === "ticket.source_integration_rebased").payload.commit_sha, "7fe94fad0e8b9b1f70e838b2d902b2e6e1d20e46");
    // The reacquired claim keeps the original claim identity so later commits stay eligible.
    assert.deepEqual(JSON.parse(await files.readFile({ path: ledgerClaimPath(path) })), { task_id: "TICKET-SOURCE", path, claim_id: manifest.entries[path].claim_id });
    await observed.snapshot("TICKET-SOURCE");
    await observed.withCommitTransaction("TICKET-SOURCE", (drain) => assert.equal(drain.entries[path].operations.at(-1).integrated_from, "TICKET-FOUNDATION"));
    // A second resume is idempotent: no drift remains and no duplicate rebase operation appears.
    await observed.resume("TICKET-SOURCE", { integrated_successors: ["TICKET-FOUNDATION"] });
    assert.equal((await observed.load("TICKET-SOURCE")).entries[path].operations.filter((item) => item.integrated_from).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resume rejects successors that forked elsewhere, lack receipts, or are ambiguous", async () => {
  const sha = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const root = await mkdtemp(join(tmpdir(), "nodeforge-ticket-rebase-reject-"));
  try {
    const { files, ledger, path } = await driftScenario(root);
    const successor = JSON.parse(await files.readFile({ path: ledgerManifestPath("TICKET-FOUNDATION") }));
    // A successor that did not start at this ticket's baseline is unrelated drift.
    const forked = structuredClone(successor);
    forked.task_id = "TICKET-FORKED";
    forked.entries[path].initial_sha = sha("different base");
    forked.entries[path].initial_content = "different base";
    forked.entries[path].operations[0].before_sha = sha("different base");
    await files.atomicWrite({ path: ledgerManifestPath("TICKET-FORKED"), content: JSON.stringify(forked), replace: true });
    await assert.rejects(ledger.resume("TICKET-SOURCE", { integrated_successors: ["TICKET-FORKED"] }), { code: "TICKET_SOURCE_CHANGED" });
    // A closed successor without a commit receipt cannot prove integration.
    const uncommitted = structuredClone(successor);
    uncommitted.task_id = "TICKET-UNCOMMITTED";
    uncommitted.commits = {};
    await files.atomicWrite({ path: ledgerManifestPath("TICKET-UNCOMMITTED"), content: JSON.stringify(uncommitted), replace: true });
    await assert.rejects(ledger.resume("TICKET-SOURCE", { integrated_successors: ["TICKET-UNCOMMITTED"] }), { code: "TICKET_SOURCE_CHANGED" });
    // Two equally valid successors cannot silently choose one.
    const ambiguous = structuredClone(successor);
    ambiguous.task_id = "TICKET-FOUNDATION-A";
    await files.atomicWrite({ path: ledgerManifestPath("TICKET-FOUNDATION-A"), content: JSON.stringify(ambiguous), replace: true });
    await assert.rejects(ledger.resume("TICKET-SOURCE", { integrated_successors: ["TICKET-FOUNDATION", "TICKET-FOUNDATION-A"] }), { code: "TICKET_SOURCE_CHANGED" });
    // Rejection leaves no claims acquired and the source manifest unchanged.
    await assert.rejects(files.readFile({ path: ledgerClaimPath(path) }), { code: "ENOENT" });
    const manifest = await ledger.load("TICKET-SOURCE");
    assert.equal(manifest.entries[path].latest_sha, sha("source v1"));
    assert.equal(manifest.revision, 1);
    // The approved single successor still rebases cleanly after every rejection.
    await ledger.resume("TICKET-SOURCE", { integrated_successors: ["TICKET-FOUNDATION"] });
    assert.equal((await ledger.load("TICKET-SOURCE")).entries[path].latest_sha, sha("foundation v2"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ledger move, delete, rollback, and injected write failure preserve BOTH_PATHS_COUNTED and clean parent directories", async () => {
  const sha = (content) => content === null ? null : `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const root = await mkdtemp(join(tmpdir(), "nodeforge-ticket-move-rollback-"));
  try {
    const files = createFileService({ projectRoot: root });
    const ledger = createTicketChangeLedger({ fileService: files, projectId: "PROJECT-TEST" });
    const sourcePath = "backend/src/legacy/nested/module.js";
    const destPath = "backend/src/modern/relocated/module.js";
    const deletePath = "backend/src/obsolete/deep/remove-me.js";
    const sourceContent = "// legacy module\nexport const val = 42;\n";
    const deleteContent = "// obsolete\nexport const gone = true;\n";
    await files.atomicWrite({ path: sourcePath, content: sourceContent, replace: true });
    await files.atomicWrite({ path: deletePath, content: deleteContent, replace: true });

    // 1. Delete records after: null, unlinks file, and prunes empty parent directory:
    await ledger.write({ taskId: "TICKET-MOVE", path: deletePath, before: deleteContent, after: null });
    await assert.rejects(files.readFile({ path: deletePath }), { code: "ENOENT" });
    assert.deepEqual(await files.listDirectories({ glob: "backend/src/obsolete/**" }), []);

    // 2. Move records both fromPath (after: null) and toPath (before: null, after: sourceContent):
    const moveRes = await ledger.move({ taskId: "TICKET-MOVE", fromPath: sourcePath, toPath: destPath, before: sourceContent });
    assert.equal(moveRes.moved, true);
    assert.equal(moveRes.sha256, sha(sourceContent));
    await assert.rejects(files.readFile({ path: sourcePath }), { code: "ENOENT" });
    assert.equal(await files.readFile({ path: destPath }), sourceContent);
    assert.deepEqual(await files.listDirectories({ glob: "backend/src/legacy/**" }), []);

    const snap = await ledger.snapshot("TICKET-MOVE");
    assert.deepEqual(Object.keys(snap.entries).sort(), [deletePath, destPath, sourcePath].sort());
    assert.equal(snap.entries[sourcePath].initial_sha, sha(sourceContent));
    assert.equal(snap.entries[sourcePath].latest_sha, null);
    assert.equal(snap.entries[sourcePath].operations.at(-1).after, null);
    assert.equal(snap.entries[destPath].initial_sha, null);
    assert.equal(snap.entries[destPath].latest_sha, sha(sourceContent));
    assert.equal(snap.entries[destPath].operations.at(-1).before, null);
    assert.equal(snap.entries[destPath].operations.at(-1).after, sourceContent);

    // 3. Rollback restores deleted and moved source files, removes destination file, and prunes empty created directories:
    await ledger.rollback("TICKET-MOVE", { close: false });
    assert.equal(await files.readFile({ path: sourcePath }), sourceContent);
    assert.equal(await files.readFile({ path: deletePath }), deleteContent);
    await assert.rejects(files.readFile({ path: destPath }), { code: "ENOENT" });
    assert.deepEqual(await files.listDirectories({ glob: "backend/src/modern/**" }), []);

    // 4. Precondition rejections (claim conflict, occupied destination, checksum mismatch) and injected delete failure:
    await ledger.write({ taskId: "TICKET-OTHER", path: deletePath, before: deleteContent, after: "// claimed\n" });
    await assert.rejects(
      ledger.move({ taskId: "TICKET-MOVE", fromPath: sourcePath, toPath: deletePath, before: sourceContent }),
      { code: "FILE_CLAIM_CONFLICT" }
    );
    await ledger.rollback("TICKET-OTHER", { close: true });

    await assert.rejects(
      ledger.move({ taskId: "TICKET-MOVE", fromPath: sourcePath, toPath: deletePath, before: sourceContent }),
      { code: "FILE_ALREADY_EXISTS" }
    );
    await assert.rejects(
      ledger.move({ taskId: "TICKET-MOVE", fromPath: sourcePath, toPath: destPath, before: "// wrong checksum\n" }),
      { code: "CHECKSUM_MISMATCH" }
    );

    // Injected failure during source unlink rolls back destination file and ledger entries:
    const failingFiles = {
      ...files,
      deleteFile: async (input) => {
        if (input.path === sourcePath) throw Object.assign(new Error("Simulated unlink failure"), { code: "EIO" });
        return files.deleteFile(input);
      }
    };
    const failingLedger = createTicketChangeLedger({ fileService: failingFiles, projectId: "PROJECT-TEST" });
    await assert.rejects(
      failingLedger.move({ taskId: "TICKET-MOVE", fromPath: sourcePath, toPath: destPath, before: sourceContent }),
      { code: "EIO" }
    );
    assert.equal(await files.readFile({ path: sourcePath }), sourceContent);
    await assert.rejects(files.readFile({ path: destPath }), { code: "ENOENT" });
    assert.deepEqual(Object.keys((await ledger.snapshot("TICKET-MOVE")).entries), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
