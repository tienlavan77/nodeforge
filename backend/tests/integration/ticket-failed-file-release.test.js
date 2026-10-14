// Verifies failed ticket file claims are released and safe retries retain their original source journal.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket-change-ledger.js";

// Creates real project-local files and a durable claim ledger for a failed ticket.
async function fixture(context) {
  const root = await mkdtemp(join(process.cwd(), ".forge/runtime/ticket-failed-release-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const files = createFileService({ projectRoot: root });
  const ledger = createTicketChangeLedger({ projectId: "PROJECT-A", fileService: files });
  await files.atomicWrite({ path: "backend/source.js", content: "original", replace: true });
  await ledger.write({ taskId: "TICKET-A", path: "backend/source.js", before: "original", after: "changed" });
  return { files, ledger };
}

// Reclaims source before committing a resumed attempt without resetting revision or operations.
test("failed ticket releases source and resumes the same durable journal", async (context) => {
  const { files, ledger } = await fixture(context);
  await ledger.release("TICKET-A", { close: false });
  const released = await ledger.load("TICKET-A");
  assert.equal(released.state, "active");
  assert.equal(released.revision, 1);
  await ledger.resume("TICKET-A");
  await assert.rejects(ledger.write({ taskId: "TICKET-B", path: "backend/source.js", before: "changed", after: "foreign" }), { code: "FILE_CLAIM_CONFLICT" });
  await ledger.withCommitTransaction("TICKET-A", async (manifest) => assert.equal(manifest.revision, 1));
  await ledger.write({ taskId: "TICKET-A", path: "backend/source.js", before: "changed", after: "resumed" });
  assert.equal((await ledger.load("TICKET-A")).revision, 2);
  assert.equal(await files.readFile({ path: "backend/source.js" }), "resumed");
});

// Lets a different ticket claim a released file while preventing the old retry from stealing it.
test("another ticket can claim released source and old retries cannot steal its ownership", async (context) => {
  const { ledger } = await fixture(context);
  await ledger.release("TICKET-A", { close: false });
  await ledger.write({ taskId: "TICKET-B", path: "backend/source.js", before: "changed", after: "foreign" });
  await assert.rejects(ledger.resume("TICKET-A"), { code: "FILE_CLAIM_CONFLICT" });
  await ledger.release("TICKET-A", { close: false });
  await ledger.write({ taskId: "TICKET-B", path: "backend/source.js", before: "foreign", after: "still-owned" });
});

// Refuses a retry if unclaimed source drifted, rather than overwriting work performed after failure.
test("unclaimed source drift blocks retry without discarding the failed journal", async (context) => {
  const { files, ledger } = await fixture(context);
  await ledger.release("TICKET-A", { close: false });
  await files.atomicWrite({ path: "backend/source.js", content: "owner-change", replace: true });
  await assert.rejects(ledger.resume("TICKET-A"), { code: "TICKET_SOURCE_CHANGED" });
  assert.equal((await ledger.load("TICKET-A")).revision, 1);
  assert.equal(await files.readFile({ path: "backend/source.js" }), "owner-change");
});

// Rolls back newly acquired claims if any later path cannot be resumed safely.
test("partial resume failure does not leave earlier paths claimed", async (context) => {
  const { files, ledger } = await fixture(context);
  await files.atomicWrite({ path: "backend/other.js", content: "original", replace: true });
  await ledger.write({ taskId: "TICKET-A", path: "backend/other.js", before: "original", after: "changed" });
  await ledger.release("TICKET-A", { close: false });
  await ledger.write({ taskId: "TICKET-B", path: "backend/other.js", before: "changed", after: "foreign" });
  await assert.rejects(ledger.resume("TICKET-A"), { code: "FILE_CLAIM_CONFLICT" });
  await ledger.write({ taskId: "TICKET-C", path: "backend/source.js", before: "changed", after: "available" });
  assert.equal(await files.readFile({ path: "backend/source.js" }), "available");
});

// Keeps completed ticket journals closed while making their source claims available to other work.
test("completed tickets release source claims and cannot reopen their completed journal", async (context) => {
  const { ledger } = await fixture(context);
  await ledger.release("TICKET-A");
  assert.equal((await ledger.load("TICKET-A")).state, "closed");
  await assert.rejects(ledger.write({ taskId: "TICKET-A", path: "backend/source.js", before: "changed", after: "reopened" }), { code: "TICKET_CHANGE_CLOSED" });
  await ledger.write({ taskId: "TICKET-B", path: "backend/source.js", before: "changed", after: "next-ticket" });
});
