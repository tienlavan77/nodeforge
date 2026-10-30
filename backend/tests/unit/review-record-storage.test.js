// Verifies immutable review persistence, crash recovery and compatibility without runtime migration.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createReviewRecordStorage } from "../../src/modules/supervisor/review/review-record-storage.js";
import { createQueryReviewTool } from "../../src/tools/reporting/query-review-tool.js";
import { createTicketReviewFindingsStore } from "../../src/modules/supervisor/ticket/ticket-review-findings.js";

// Supplies isolated, real File Service persistence for restart and lock checks.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nf-review-records-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fileService = createFileService({ projectRoot: root });
  const storage = createReviewRecordStorage({ taskId: "T", fileService });
  return { root, fileService, storage };
}

// Provides a representative finding exchange, including independently addressable reports and decisions.
function state() {
  return { task_id: "T", version: 1, next_id: 2, findings: [{ finding_id: "REV-1", message: "Repair scanner", status: "open", history: [] }],
    coder_reports: [{ idempotency_key: "R1", report: { summary: "Implemented scanner", evidence: ["x".repeat(50_000)] } }],
    coder_responses: [], adjudications: [] };
}

test("new review storage deduplicates records and preserves exact finding revisions after restart", async (t) => {
  const { root, fileService, storage } = await fixture(t);
  const initial = state();
  await storage.save(initial);
  assert.deepEqual(await storage.load(), initial);
  const before = await readdir(join(root, ".forge/runtime/review-records/T/coder_reports"));
  const next = structuredClone(initial);
  next.version++; next.findings[0].status = "fixed";
  await storage.save(next);
  assert.deepEqual(await readdir(join(root, ".forge/runtime/review-records/T/coder_reports")), before);
  const restarted = createReviewRecordStorage({ taskId: "T", fileService });
  assert.deepEqual(await restarted.load(), next);
  const snapshot = await restarted.loadQuery();
  assert.deepEqual(snapshot.query_finding_revisions["REV-1"].map((entry) => entry.status), ["open", "fixed"]);
  const indexText = await readFile(join(root, storage.indexPath), "utf8");
  assert.ok(indexText.length < 3000);
  assert.ok(!indexText.includes("x".repeat(1000)));
  await assert.rejects(readFile(join(root, ".forge/runtime/ticket-review-findings/T.json")), { code: "ENOENT" });
});

test("partial writes leave the old index readable and retry reconciles orphan records idempotently", async (t) => {
  const { fileService, storage } = await fixture(t);
  const initial = state(); await storage.save(initial);
  const next = structuredClone(initial); next.version++; next.findings[0].message = "New evidence";
  const broken = createReviewRecordStorage({ taskId: "T", fileService: { ...fileService, atomicWrite: async (input) => {
    if (input.path.endsWith("index.json")) throw Object.assign(new Error("simulated crash"), { code: "CRASH" });
    return fileService.atomicWrite(input);
  } } });
  await assert.rejects(broken.save(next), { code: "CRASH" });
  assert.deepEqual(await storage.load(), initial);
  await storage.save(next); await storage.save(next);
  assert.deepEqual(await storage.load(), next);
  assert.equal((await storage.loadQuery()).query_finding_revisions["REV-1"].length, 2);
});

test("legacy evidence remains byte-for-byte untouched on read and retains its format on updates", async (t) => {
  const { root, fileService, storage } = await fixture(t);
  const path = ".forge/runtime/ticket-review-findings/T.json", content = JSON.stringify(state(), null, 2);
  await fileService.atomicWrite({ path, content });
  assert.deepEqual(await storage.loadQuery(), state());
  assert.equal(await fileService.readFile({ path }), content);
  await assert.rejects(readdir(join(root, ".forge/runtime/review-records")), { code: "ENOENT" });
  const next = state(); next.version++;
  await storage.save(next);
  assert.deepEqual(JSON.parse(await fileService.readFile({ path })), next);
  await assert.rejects(readdir(join(root, ".forge/runtime/review-records")), { code: "ENOENT" });
});

test("simultaneous reports are serialized through the real finding store without lost updates", async (t) => {
  const { fileService } = await fixture(t);
  const artifact = { status: "passed", artifact_id: "A", commit_sha: "C", source_revision: "S", manifest_sha: "M" };
  const options = { taskId: "T", fileService, executionContexts: { load: async () => ({ verification_artifact_id: "A", review_commit_sha: "C", source_revision: "S", manifest_sha: "M" }) } };
  const stores = [createTicketReviewFindingsStore(options), createTicketReviewFindingsStore(options)];
  await Promise.all(stores.map((store, index) => store.recordCoderReport({ artifact, report: { summary: `Report ${index}` }, idempotencyKey: `REPORT-${index}` })));
  const snapshot = await stores[0].load();
  assert.equal(snapshot.coder_reports.length, 2);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.task_id, "T");
});

test("corrupt immutable records fail explicitly instead of returning incomplete evidence", async (t) => {
  const { fileService, storage } = await fixture(t);
  await storage.save(state());
  const index = JSON.parse(await fileService.readFile({ path: storage.indexPath }));
  const ref = index.collections.coder_reports[0];
  await fileService.atomicWrite({ path: `.forge/runtime/review-records/T/${ref.kind}/${ref.hash}.json`, content: "{}", replace: true });
  await assert.rejects(storage.load(), /missing or corrupt/);
});

// Ensures the lookup tool resolves one report from metadata without reading unrelated payloads.
test("indexed exact lookup reads only its selected report and keeps old draft revisions addressable", async (t) => {
  const { fileService, storage } = await fixture(t);
  const initial = state();
  initial.coder_report_drafts = [{ artifact_id: "A", report: { summary: "First draft" } }];
  await storage.save(initial);
  const next = structuredClone(initial); next.version++;
  next.coder_report_drafts[0].report.summary = "Supplemented draft";
  await storage.save(next);
  const paths = [];
  const reader = createReviewRecordStorage({ taskId: "T", fileService: { ...fileService, readFile: async (input) => {
    paths.push(input.path); return fileService.readFile(input);
  } } });
  const tool = createQueryReviewTool({ queryRecords: reader.queryRecords, taskId: "T", projectId: "P" });
  const context = { task_id: "T", project_id: "P", capabilities: ["query_review"], agent_identity: { role: "reviewer" } };
  const result = await tool.execute({ action: "get", kind: "draft", id: "A", revision: 1 }, context);
  assert.equal(JSON.parse(result.json_fragment).report.summary, "First draft");
  assert.ok(paths.every((path) => !path.includes("/coder_reports/") && !path.includes("/findings/")));
  const catalog = await tool.execute({ action: "search", kind: "draft", id: "A" }, context);
  assert.deepEqual(catalog.records.map((entry) => entry.revision), [1, 2]);
});

test("identical history entries deduplicate safely during one atomic save", async (t) => {
  const { storage } = await fixture(t);
  const value = state();
  value.findings[0].history = Array.from({ length: 12 }, () => ({ message: "Same retained evidence" }));
  await storage.save(value);
  assert.deepEqual(await storage.load(), value);
});

// Restores published metadata without importing uncommitted orphans or writing from a query.
test("lost or corrupt primary indexes recover from the published backup without query mutations", async (t) => {
  const { fileService, storage } = await fixture(t);
  const initial = state(); await storage.save(initial);
  await fileService.deleteFile({ path: storage.indexPath });
  const readOnly = createReviewRecordStorage({ taskId: "T", fileService: { ...fileService, atomicWrite: async () => { throw new Error("Read query wrote data"); } } });
  assert.deepEqual(await readOnly.load(), initial);
  await fileService.atomicWrite({ path: storage.indexPath, content: "{broken json", replace: true });
  assert.deepEqual(await readOnly.load(), initial);
  await fileService.atomicWrite({ path: storage.indexPath, content: "{}", replace: true });
  assert.deepEqual(await readOnly.load(), initial);
  await storage.save(initial);
  assert.equal(JSON.parse(await fileService.readFile({ path: storage.indexPath })).state.version, 1);
});

// Binds Coder replies and Reviewer decisions to exact retained finding revisions without agent-authored hashes.
test("Node records finding revision bindings alongside response and adjudication evidence", async (t) => {
  const { fileService } = await fixture(t);
  const artifact = { status: "passed", artifact_id: "A", commit_sha: "C", source_revision: "S", manifest_sha: "M" };
  const store = createTicketReviewFindingsStore({ taskId: "T", fileService, executionContexts: { load: async () => ({
    verification_artifact_id: "A", review_commit_sha: "C", source_revision: "S", manifest_sha: "M"
  }) } });
  const binding = { artifactId: "A", commitSha: "C", sourceRevision: "S", reviewerId: "REVIEWER" };
  await store.recordReview({ ...binding, verdict: "request_changes", findings: ["Repair scanner"] });
  const responses = [{ finding_id: "REV-1", position: "accept", rationale: "Repaired scanner", files: [], evidence_refs: ["A"] }];
  const response = await store.recordResponse({ responses, artifact, actor: "CODER", idempotencyKey: "RESPONSE" });
  assert.equal(response.finding_revisions["REV-1"].revision, 1);
  await store.recordReview({ ...binding, verdict: "approved", findings: [], adjudications: [{
    finding_id: "REV-1", decision: "fixed", reason: "Verified", evidence_refs: ["A"]
  }] });
  const state = await store.load();
  assert.equal(state.adjudications[0].finding_revision, 1);
  assert.equal(state.adjudications[0].finding_record_sha256, response.finding_revisions["REV-1"].record_sha256);
});
