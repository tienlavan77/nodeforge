// Exercises exact review lookup, lossless pagination and shared provider authorization.
import test from "node:test";
import assert from "node:assert/strict";
import { createQueryReviewTool, queryReviewDefinition } from "../../src/tools/query-review-tool.js";
import { coderToolDefinitions } from "../../src/tools/engineering-tool-catalog.js";
import { createForgeSdkMcpServer, forgeSdkToolNames } from "../../src/tools/claude-sdk-forge-tools.js";
import { createOwnerClaudeMcpTools } from "../../src/tools/owner-claude-mcp-tools.js";
import { createReviewExchangeEvidence, attachReviewExchangeTools } from "../../src/modules/supervisor/review-exchange-evidence.js";
import { currentReviewFindings, reviewQueryPrompt } from "../../src/modules/supervisor/review-query-records.js";
import { checkpointPayload, createResumeState } from "../../src/modules/supervisor/ticket-resume.js";

const context = { task_id: "T", project_id: "P", capabilities: ["query_review"], agent_identity: { role: "reviewer", agent_id: "REVIEWER" } };

// Creates snapshot-based query fixtures whose evidence is never served through a filesystem read.
function fixture(exchange) {
  const snapshot = { task_id: "T", ...exchange };
  const tool = createQueryReviewTool({ taskId: "T", projectId: "P", load: async () => snapshot });
  return { execute: (input, issued = context) => tool.execute(input, issued), snapshot };
}

// Reads every explicit page before decoding an exact structured review record.
async function readRecord(execute, input) {
  let cursor, text = "", pages = 0;
  do {
    const page = await execute({ action: "get", ...input, ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 16_000);
    assert.equal(page.complete, page.next_cursor === null);
    text += page.json_fragment; cursor = page.next_cursor; pages++;
  } while (cursor);
  return { value: JSON.parse(text), pages };
}

test("exact report lookup returns all content above 1 MB without silent truncation", async () => {
  const report = { summary: "Repair scanner", evidence: ["Tiếng Việt 😀 ".repeat(60_000), "last evidence must survive"] };
  const { execute } = fixture({ coder_reports: [{ idempotency_key: "REPORT-1", review_commit_sha: "COMMIT-1", report }] });
  const result = await readRecord(execute, { kind: "report", id: "REPORT-1" });
  assert.ok(Buffer.byteLength(JSON.stringify(report)) > 1_000_000);
  assert.ok(result.pages > 100);
  assert.deepEqual(result.value.report, report);
  const section = await readRecord(execute, { kind: "report", id: "REPORT-1", section: "/report/evidence/1" });
  assert.equal(section.value, "last evidence must survive");
});

test("literal search locates historical definitions, reports, responses and adjudications with pagination", async () => {
  const { execute } = fixture({ findings: [{ finding_id: "REV-1", status: "fixed", message: "new issue", history: [{ message: "original needle", review_commit_sha: "OLD" }] }],
    coder_reports: [{ idempotency_key: "REPORT", report: { summary: "needle" }, review_commit_sha: "OLD", recorded_at: "2026-10-21T00:00:00Z" }],
    coder_responses: [{ idempotency_key: "RESPONSE", responses: [{ finding_id: "REV-1", rationale: "needle" }] }],
    adjudications: [{ finding_id: "REV-1", decision: "fixed", reason: "needle" }] });
  let cursor, records = [];
  do {
    const page = await execute({ action: "search", query: "needle", limit: 1, ...(cursor ? { cursor } : {}) });
    records.push(...page.records); cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(records.map(({ kind }) => kind), ["finding", "report", "response", "adjudication"]);
  assert.equal(records[0].revision, 1);
  assert.equal((await readRecord(execute, { kind: "finding", id: "REV-1", revision: 1 })).value.message, "original needle");
  assert.equal((await execute({ action: "search", kind: "report", commit_sha: "OLD", after: "2026-10-20T00:00:00Z" })).records[0].id, "REPORT");
  assert.equal((await execute({ action: "search", finding_id: "REV-1", kind: "response" })).total, 1);
});

test("new stored finding revisions remain exact even when only the status changes", async () => {
  const { execute } = fixture({ findings: [{ finding_id: "REV-1", status: "fixed" }], query_finding_revisions: {
    "REV-1": [{ finding_id: "REV-1", status: "open" }, { finding_id: "REV-1", status: "fixed" }]
  } });
  assert.equal((await readRecord(execute, { kind: "finding", id: "REV-1", revision: 1 })).value.status, "open");
  assert.equal((await readRecord(execute, { kind: "finding", id: "REV-1" })).value.status, "fixed");
});

test("ticket, project, role and capability checks reject authority supplied by a caller", async () => {
  const { execute } = fixture({});
  for (const input of [{ ticket_id: "OTHER" }, { project_id: "OTHER" }]) await assert.rejects(execute({ action: "search", ...input }), { code: "REVIEW_QUERY_FORBIDDEN" });
  await assert.rejects(execute({ action: "search" }, { ...context, task_id: "OTHER" }), { code: "REVIEW_QUERY_FORBIDDEN" });
  await assert.rejects(execute({ action: "search" }, { ...context, project_id: "OTHER" }), { code: "REVIEW_QUERY_FORBIDDEN" });
  await assert.rejects(execute({ action: "search" }, { ...context, capabilities: [] }), { code: "TOOL_FORBIDDEN" });
  await assert.rejects(execute({ action: "search" }, { ...context, agent_identity: { role: "system_engineer" } }), { code: "REVIEW_QUERY_FORBIDDEN" });
  for (const input of [{ path: "../secret" }, { limit: 21 }, { cursor: "bad" }, { after: "bad date" }])
    await assert.rejects(execute({ action: "search", ...input }));
  await assert.rejects(execute({ action: "get", kind: "report", id: "MISSING" }), { code: "REVIEW_RECORD_NOT_FOUND" });
});

test("cursor binds query and evidence snapshot; stale pages never silently mix revisions", async () => {
  let exchange = { task_id: "T", coder_reports: [{ idempotency_key: "R", report: { summary: "x".repeat(12_000) } }] };
  const tool = createQueryReviewTool({ load: async () => structuredClone(exchange), taskId: "T", projectId: "P" });
  const input = { action: "get", kind: "report", id: "R" };
  const first = await tool.execute(input, context);
  await assert.rejects(tool.execute({ ...input, section: "/report", cursor: first.next_cursor }, context), { code: "REVIEW_QUERY_CURSOR_INVALID" });
  exchange = { ...exchange, coder_reports: [{ idempotency_key: "R", report: { summary: "y".repeat(12_000) } }] };
  await assert.rejects(tool.execute({ ...input, cursor: first.next_cursor }, context), { code: "REVIEW_QUERY_STALE" });
});

test("Coder and Reviewer advertise the same query schema to Codex and Claude", async () => {
  assert.deepEqual(coderToolDefinitions().find(({ name }) => name === "query_review"), queryReviewDefinition);
  assert.ok(forgeSdkToolNames.includes("mcp__forge__query_review"));
  const events = [], exchange = { task_id: "T", findings: [{ finding_id: "REV-1", message: "old", history: [{ message: "old original" }] }] };
  const tools = attachReviewExchangeTools({ definitions: [], registry: {}, context }, createReviewExchangeEvidence("T", exchange), {
    job: { task_id: "T", project_id: "P", request_id: "REQUEST" }, reviewer: { agent_id: "REVIEWER" }, projectLogger: (event) => events.push(event)
  });
  assert.deepEqual(tools.definitions, [queryReviewDefinition]);
  assert.ok(createOwnerClaudeMcpTools(tools).allowedTools.includes("mcp__forge__query_review"));
  assert.ok(createForgeSdkMcpServer({ registry: tools.registry, context, includeEngineeringTools: true }));
  await tools.registry.query_review.execute({ action: "get", kind: "finding", id: "REV-1", revision: 1 });
  assert.equal(events[0].payload.tool, "query_review");
  assert.equal(events[0].payload.complete, true);
  const saved = checkpointPayload(createResumeState({ status: "in_progress", review_findings: exchange.findings }));
  assert.deepEqual(saved.review_findings, currentReviewFindings(exchange.findings));
  assert.ok(!JSON.stringify(saved).includes("old original"));
  assert.match(reviewQueryPrompt(exchange), /query_review/);
  assert.ok(!reviewQueryPrompt(exchange).includes("old original"));
});

test("query results redact secrets and never traverse prototypes", async () => {
  const { execute } = fixture({ coder_reports: [{ idempotency_key: "R", report: { summary: "Bearer abc.def.ghi" } }] });
  assert.equal((await readRecord(execute, { kind: "report", id: "R" })).value.report.summary, "Bearer [REDACTED]");
  await assert.rejects(execute({ action: "get", kind: "report", id: "R", section: "/constructor" }), { code: "REVIEW_RECORD_NOT_FOUND" });
});
