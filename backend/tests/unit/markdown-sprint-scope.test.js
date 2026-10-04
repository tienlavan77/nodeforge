// Verifies Sprint Leader work groups remain within the owner-approved Markdown table.
import assert from "node:assert/strict";
import test from "node:test";
import { assertMarkdownSprintScope, projectMarkdownSprintScope, readMarkdownSprintScope } from "../../src/modules/governance/markdown-sprint-scope.js";

const markdown = "# Plan: API\n\n## 5. Tickets\n\n| Thứ tự | Nhóm việc | Implementation type | Mục tiêu | Phụ thuộc | Mutable-file budget | Acceptance criteria |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | API | backend | Return errors | — | ≤ 3 files | API returns canonical errors |\n| 2 | Screen | frontend | Display errors | API | ≤ 2 files | UI displays errors |\n\n## 6. Risks\n";
const tickets = [{ id: "TICKET-A", title: "API", objective: "Return errors", implementation_type: ["backend"], file_budget: 3, acceptance_criteria: ["API returns canonical errors"] }, { id: "TICKET-B", title: "Screen", objective: "Display errors", implementation_type: ["frontend"], file_budget: 2, dependencies: ["TICKET-A"], acceptance_criteria: ["UI displays errors"] }];

test("approved Markdown fixes Sprint work-group order, type, and file budget", () => {
  assert.equal(readMarkdownSprintScope(markdown).length, 2);
  assert.equal(assertMarkdownSprintScope(markdown, { tickets }).length, 2);
  assert.throws(() => assertMarkdownSprintScope(markdown, { tickets: tickets.slice(0, 1) }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => assertMarkdownSprintScope(markdown, { tickets: [...tickets, tickets[0]] }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => assertMarkdownSprintScope(markdown, { tickets: [tickets[1], tickets[0]] }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => assertMarkdownSprintScope(markdown, { tickets: [{ ...tickets[0], objective: "Add unrelated endpoint" }, tickets[1]] }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => assertMarkdownSprintScope(markdown, { tickets: [{ ...tickets[0], file_budget: 4 }, tickets[1]] }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => assertMarkdownSprintScope(markdown, { tickets: [tickets[0], { ...tickets[1], dependencies: [] }] }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => assertMarkdownSprintScope(markdown, { tickets: [tickets[0], { ...tickets[1], acceptance_criteria: ["New unrelated behavior"] }] }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => readMarkdownSprintScope("# Plan: API\n\n## 5. Tickets\n\nNo table"), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => readMarkdownSprintScope(markdown.replace("≤ 3 files", "≤ 10 files")), { code: "SPRINT_MARKDOWN_SCOPE" });
});

// Keeps approved human decisions as external prerequisites rather than invented ticket IDs.
test("approved decision prerequisites do not require a Sprint ticket dependency", () => {
  const withDecision = markdown.replace("| API | ≤ 2 files", "| API; Message-window decision | ≤ 2 files");
  assert.equal(assertMarkdownSprintScope(withDecision, { tickets }).length, 2);
  assert.throws(() => assertMarkdownSprintScope(withDecision.replace("Message-window decision", "Unknown work"), { tickets }), { code: "SPRINT_MARKDOWN_SCOPE" });
});

// Projects approved ticket scope from Markdown while rejecting invalid Sprint structure.
test("approved Markdown owns ticket scope and dependency IDs", () => {
  const projected = projectMarkdownSprintScope(markdown, { id: "SPRINT-A", tickets: [{ id: "TICKET-A", title: "Wrong", objective: "Wrong", implementation_type: ["frontend"], file_budget: 1, acceptance_criteria: ["Wrong"] }, { id: "TICKET-B", dependencies: ["TICKET-OTHER"] }] });
  assert.deepEqual(projected.tickets, [{ ...tickets[0], dependencies: [] }, tickets[1]]);
  assert.throws(() => projectMarkdownSprintScope(markdown, { tickets: [{ id: "TICKET-A" }] }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => projectMarkdownSprintScope(markdown, { tickets: [{ id: "TICKET-A" }, { id: "TICKET-A" }] }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => projectMarkdownSprintScope(markdown.replace("| API | ≤ 2 files", "| Unknown work | ≤ 2 files"), { tickets: [{ id: "TICKET-A" }, { id: "TICKET-B" }] }), { code: "SPRINT_MARKDOWN_SCOPE" });
});

// Drops source file hints so the Coder discovers implementation paths.
test("approved Markdown projection omits ticket file hints", () => {
  const reference = { path: "backend/src/error-contract.js", role: "REFERENCE", reason: "Observed in Forge search" };
  const projected = projectMarkdownSprintScope(markdown, { tickets: [{ id: "TICKET-A", candidate_files: [reference], candidates_produced_by: "sprint_leader", candidates_produced_at: "2026-10-03T00:00:00Z" }, { id: "TICKET-B" }] });
  assert.equal(projected.tickets[0].candidate_files, undefined);
  assert.equal(projected.tickets[0].candidates_produced_by, undefined);
});

// Lets Sprint Leader choose ticket boundaries while covering each approved Architecture outcome.
test("outcome Markdown accepts autonomous ticket decomposition with explicit coverage", () => {
  const outcomes = "# Plan: API\n\n## 5. Outcomes và điều kiện nghiệm thu\n\n| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |\n| --- | --- | --- | --- |\n| O1 | Canonical API | HTTP errors use canonical fields | — |\n| O2 | UI errors | UI displays canonical fields | O1 |\n\n## 6. Rủi ro\n";
  const rows = readMarkdownSprintScope(outcomes);
  assert.deepEqual(rows.map((row) => row.id), ["O1", "O2"]);
  const proposal = { tickets: [{ id: "TICKET-API", title: "Update API", objective: "Return canonical errors", implementation_type: ["backend"], file_budget: 3, acceptance_criteria: ["HTTP errors use canonical fields"], outcome_refs: ["O1"] }, { id: "TICKET-UI", title: "Update UI", objective: "Render canonical errors", implementation_type: ["frontend"], file_budget: 2, dependencies: ["TICKET-API"], acceptance_criteria: ["UI displays canonical fields"], outcome_refs: ["O2"] }] };
  assert.deepEqual(projectMarkdownSprintScope(outcomes, proposal).tickets.map((ticket) => ticket.title), ["Update API", "Update UI"]);
  assert.throws(() => projectMarkdownSprintScope(outcomes, { tickets: proposal.tickets.slice(0, 1) }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => projectMarkdownSprintScope(outcomes, { tickets: [{ ...proposal.tickets[0], outcome_refs: ["O3"] }, proposal.tickets[1]] }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => projectMarkdownSprintScope(outcomes, { tickets: [{ ...proposal.tickets[0], file_budget: 5 }, proposal.tickets[1]] }), { code: "SPRINT_MARKDOWN_SCOPE" });
});

// Accepts the Architecture summary ID contract without accepting unfinished outcome text.
test("outcome O5 accepts SUMMARY-<uuid> but still rejects unfilled placeholders", () => {
  const outcome = "# Plan\n\n## 5. Outcomes và điều kiện nghiệm thu\n\n| Mã | Outcome | Acceptance | Guardrail |\n| --- | --- | --- | --- |\n| O5 | `/summary` tạo input planning thực chất | Summary phản ánh phần vừa trao đổi và có mục tiêu, in/out scope, quyết định, giả định/rủi ro/câu hỏi mở; repository context chỉ nêu khi có evidence; trả `SUMMARY-<uuid>` và lưu Markdown tạm trong runtime summary; không tạo plan hoặc quyền thực thi | Thống nhất summary contract; artifact thủ công ngoài runtime không phải SUMMARY hợp lệ |\n\n## 6. Risks\n";
  assert.equal(readMarkdownSprintScope(outcome)[0].id, "O5");
  assert.throws(() => readMarkdownSprintScope(outcome.replace("Thống nhất summary contract", "<guardrail cần điền>")), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => readMarkdownSprintScope(outcome.replace("Thống nhất summary contract; artifact thủ công ngoài runtime không phải SUMMARY hợp lệ", "")), { code: "SPRINT_MARKDOWN_SCOPE" });
});
