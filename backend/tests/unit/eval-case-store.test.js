// Verifies eval-case-store parsing, filtering, and auto-append behavior.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendAutoCase,
  buildEvalCase,
  collectAutoCases,
  createEvalCaseRecorder,
  inferStyle,
  isEvalTicketId,
  isRealChangedPath,
  loadAutoCaseIds,
  parseFinalReport,
  renderAutoFile,
  writeAutoFile
} from "../../src/modules/eval/eval-case-store.js";

const SAMPLE = `# TICKET-PROJECT-NODEFORGE-1: Update conversation messages API

- Status: completed
- Generated: 2026-09-18T11:11:54.212Z
- Reason: agent_report_done

## Objective
Modify the backend endpoint GET /forge/v1/conversations/:id/messages to return history.

## Files Changed
- backend/src/application/conversation-audit-history-service.js
- backend/src/transport/http/forge-v1-router.js

## Commits
- None

## Acceptance Criteria
- [ ] The endpoint returns messages belonging to the requested conversation. (not measured by Node)
- [ ] The response includes both user and agent messages. (not measured by Node)
`;

test("isEvalTicketId accepts only real Forge tickets", () => {
  assert.equal(isEvalTicketId("TICKET-PROJECT-NODEFORGE-1"), true);
  assert.equal(isEvalTicketId("TICKET-STYLE-ADD-TICKET-001"), true);
  assert.equal(isEvalTicketId("CODEX-TOOL-LAB-1"), false);
  assert.equal(isEvalTicketId("TICKET-STREAM-SMOKE-2"), true);
  assert.equal(isEvalTicketId(null), false);
});

test("isRealChangedPath drops markers, empty entries, and prose", () => {
  assert.equal(isRealChangedPath("backend/src/application/service.js"), true);
  assert.equal(isRealChangedPath("ui/nextjs/app/globals.css"), true);
  assert.equal(isRealChangedPath("schemas/project/task.schema.json"), true);
  assert.equal(isRealChangedPath("backend/tool-lab-target.txt"), false);
  assert.equal(isRealChangedPath("None"), false);
  assert.equal(isRealChangedPath("title/objective/acceptance_criteria"), false);,
  candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
  assert.equal(isRealChangedPath("teams/organisation"), false);
  assert.equal(isRealChangedPath(""), false);
  assert.equal(isRealChangedPath(null), false);
});

test("parseFinalReport extracts ticket text and filtered files", () => {
  const parsed = parseFinalReport({ ticketId: "TICKET-PROJECT-NODEFORGE-1", markdown: SAMPLE });
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.title, "Update conversation messages API");
  assert.match(parsed.objective, /Modify the backend endpoint/);
  assert.deepEqual(parsed.realFiles, ["backend/src/application/conversation-audit-history-service.js", "backend/src/transport/http/forge-v1-router.js"]);
  assert.equal(parsed.acceptance_criteria.length, 2);,
  candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
  assert.ok(!parsed.acceptance_criteria.some((criterion) => criterion.includes("not measured by Node")));,
  candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }],
});

test("inferStyle maps ground-truth prefixes to style filters", () => {
  assert.deepEqual(inferStyle(["ui/nextjs/app/globals.css"]), ["frontend"]);
  assert.deepEqual(inferStyle(["backend/src/application/service.js", "schemas/project/task.schema.json"]), ["backend"]);
  assert.deepEqual(inferStyle(["ui/nextjs/app/page.jsx", "backend/src/application/service.js"]), ["frontend", "backend"]);
  assert.equal(inferStyle([]), undefined);
});

test("buildEvalCase keeps the baseline case shape", () => {
  const parsed = parseFinalReport({ ticketId: "TICKET-PROJECT-NODEFORGE-1", markdown: SAMPLE });
  const item = buildEvalCase({ ticketId: "TICKET-PROJECT-NODEFORGE-1", parsed });
  assert.equal(item.id, "TICKET-PROJECT-NODEFORGE-1");
  assert.deepEqual(item.style, ["backend"]);
  assert.deepEqual(item.ground_truth, parsed.realFiles);
  assert.deepEqual(item.files_changed, parsed.realFiles);
  assert.equal(typeof item.objective, "string");
});

function makeReportsRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "eval-case-store-"));
  const reports = join(root, ".forge", "runtime", "reports");
  mkdirSync(reports, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(reports, name), content);
  return root;
}

test("collectAutoCases skips lab runs, smoke probes, and empty reports", () => {
  const root = makeReportsRoot({
    "TICKET-PROJECT-NODEFORGE-1.md": SAMPLE,
    "CODEX-TOOL-LAB-1.md": SAMPLE.replace("TICKET-PROJECT-NODEFORGE-1", "CODEX-TOOL-LAB-1").replace("- backend/src/application/conversation-audit-history-service.js\n- backend/src/transport/http/forge-v1-router.js", "- backend/tool-lab-target.txt"),
    "TICKET-EMPTY-1.md": SAMPLE.replace("TICKET-PROJECT-NODEFORGE-1", "TICKET-EMPTY-1").replace("- backend/src/application/conversation-audit-history-service.js\n- backend/src/transport/http/forge-v1-router.js", "- None")
  });
  const { cases, stats } = collectAutoCases({ root });
  assert.equal(cases.length, 1);
  assert.equal(cases[0].id, "TICKET-PROJECT-NODEFORGE-1");
  assert.equal(stats.scanned, 2);
  assert.equal(stats.backfilled, 1);
  assert.equal(stats.skipped, 1);
});

test("appendAutoCase skips duplicates and writeAutoFile round-trips", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-case-append-"));
  const parsed = parseFinalReport({ ticketId: "TICKET-PROJECT-NODEFORGE-1", markdown: SAMPLE });
  const item = buildEvalCase({ ticketId: "TICKET-PROJECT-NODEFORGE-1", parsed });
  assert.equal(appendAutoCase({ root, caseItem: item }), true);
  assert.equal(appendAutoCase({ root, caseItem: item }), false);
  assert.ok(loadAutoCaseIds({ root }).has("TICKET-PROJECT-NODEFORGE-1"));
  const text = readFileSync(join(root, "backend/tests/eval/retrieval-cases-auto.js"), "utf8");
  assert.match(text, /RETRIEVAL_EVAL_CASES_AUTO/);
  const { count } = writeAutoFile({ root, cases: [item] });
  assert.equal(count, 1);
  assert.ok(renderAutoFile([item]).includes("TICKET-PROJECT-NODEFORGE-1"));
});

test("recorder appends completed tickets and never rejects non-tickets", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-case-record-"));
  const record = createEvalCaseRecorder({ root });
  const ticket = { id: "TICKET-PROJECT-NODEFORGE-1", title: "Update conversation messages API", objective: "Modify the endpoint.", acceptance_criteria: ["Returns messages."] };,
  candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
  const report = { status: "completed", files_changed: ["backend/src/application/service.js"] };
  const first = await record({ ticket, report });
  assert.equal(first.appended, true);
  const second = await record({ ticket, report });
  assert.deepEqual(second, { appended: false, reason: "duplicate" });
  assert.deepEqual(await record({ ticket: { id: "CODEX-TOOL-LAB-1" }, report }), { appended: false, reason: "non-ticket-id" });
  assert.deepEqual(await record({ ticket, report: { status: "failed", files_changed: ["backend/src/application/service.js"] } }), { appended: false, reason: "status=failed" });
  assert.deepEqual(await record({ ticket, report: { status: "completed", files_changed: [] } }), { appended: false, reason: "empty-files-changed" });
});
