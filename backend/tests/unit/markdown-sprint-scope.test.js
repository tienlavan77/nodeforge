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
  assert.equal(readMarkdownSprintScope(markdown.replace("≤ 3 files", "≤ 10 files"))[0].file_budget, 10);
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
  assert.deepEqual(projected.tickets, [{ ...tickets[0], verification_plan: undefined, dependencies: [] }, { ...tickets[1], verification_plan: undefined }]);
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
  assert.equal(projectMarkdownSprintScope(outcomes, { tickets: [{ ...proposal.tickets[0], file_budget: 10 }, proposal.tickets[1]] }).tickets[0].file_budget, 10);
  assert.throws(() => projectMarkdownSprintScope(outcomes, { tickets: [{ ...proposal.tickets[0], file_budget: 0 }, proposal.tickets[1]] }), { code: "SPRINT_MARKDOWN_SCOPE" });
});

// Accepts the Architecture summary ID contract without accepting unfinished outcome text.
test("outcome O5 accepts SUMMARY-<uuid> but still rejects unfilled placeholders", () => {
  const outcome = "# Plan\n\n## 5. Outcomes và điều kiện nghiệm thu\n\n| Mã | Outcome | Acceptance | Guardrail |\n| --- | --- | --- | --- |\n| O5 | `/summary` tạo input planning thực chất | Summary phản ánh phần vừa trao đổi và có mục tiêu, in/out scope, quyết định, giả định/rủi ro/câu hỏi mở; repository context chỉ nêu khi có evidence; trả `SUMMARY-<uuid>` và lưu Markdown tạm trong runtime summary; không tạo plan hoặc quyền thực thi | Thống nhất summary contract; artifact thủ công ngoài runtime không phải SUMMARY hợp lệ |\n\n## 6. Risks\n";
  assert.equal(readMarkdownSprintScope(outcome)[0].id, "O5");
  assert.throws(() => readMarkdownSprintScope(outcome.replace("Thống nhất summary contract", "<guardrail cần điền>")), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => readMarkdownSprintScope(outcome.replace("Thống nhất summary contract; artifact thủ công ngoài runtime không phải SUMMARY hợp lệ", "")), { code: "SPRINT_MARKDOWN_SCOPE" });
});

// Protect meaningful code examples and Markdown layout from being mistaken for unfinished Architecture fields.
test("outcome O1 accepts HTML line breaks and comment syntax from the line-budget plan", () => {
  const acceptance = "`countBudgetLines(content)` excludes blank lines and comments (`//`, `#!`, `/* ... */`, `<!-- ... -->`), preserving `#privateField`.<br> `write_diff` accepts `code_lines` ≤ 250;<br/> `read_file` retains `total_lines` and returns `code_lines`.";
  const plan = `## 5. Outcomes\n| O1 | Count source lines | ${acceptance} | Preserve compatibility |\n## 6. Risks`;
  const [outcome] = readMarkdownSprintScope(plan);
  assert.equal(outcome.id, "O1");
  assert.equal(outcome.acceptance_criteria.length, 2);
  assert.ok(outcome.acceptance_criteria[0].includes("<!-- ... -->"));
  for (const example of ["<br>", "<br />", "<BR/>", "<strong>verified</strong>", "<!-- source example -->", "<https://example.com/docs>", "`Promise<Result>`", "`<Widget enabled />`", "``const tag = `<custom-element>`;``"]) {
    assert.doesNotThrow(() => readMarkdownSprintScope(plan.replace(acceptance, `Verify ${example} behavior`)), example);
  }
  for (const placeholder of ["<kết quả cần giao>", "<tiêu chí>", "<guardrail cần điền>", "<TBD>", "`<tiêu chí>`"]) {
    assert.throws(() => readMarkdownSprintScope(plan.replace("Count source lines", placeholder)), { code: "SPRINT_MARKDOWN_SCOPE" }, placeholder);
  }
  assert.throws(() => readMarkdownSprintScope(plan.replace(acceptance, "")), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => readMarkdownSprintScope(plan.replace(acceptance, `${acceptance} <tiêu chí>`)), { code: "SPRINT_MARKDOWN_SCOPE" });
});

// Apply the same placeholder rules to older approved work-group plans while preserving their projection contract.
test("legacy work groups accept code and HTML but reject unfinished fields", () => {
  const plan = markdown.replace("Return errors", "Return errors<br> `Promise<Result>` `<!-- ... -->`");
  assert.equal(readMarkdownSprintScope(plan).length, 2);
  assert.throws(() => readMarkdownSprintScope(markdown.replace("Return errors", "<objective cần điền>")), { code: "SPRINT_MARKDOWN_SCOPE" });
});

// Treats parameterized identifiers as literal contract evidence for any domain,
// while retaining template completeness checks for missing fields and TODO text.
test("symbolic IDs and path parameters are accepted across outcome and legacy tables", () => {
  for (const syntax of ["PROJECT-<uuid>", "TICKET-<ticket_id>", "/<projectId>", "/forge/v1/projects/<project_id>", "GET /api/items/<itemId>/events/<eventId>", "stream?project=<projectId>", "Promise<Result>"]) {
    for (const row of [`| O1 | Keep ${syntax} | Verify ${syntax} | Preserve ${syntax} |`, `| O1 | Keep ${syntax} | Verify ${syntax} | Preserve ${syntax} | none |`]) {
      const [outcome] = readMarkdownSprintScope(`## 5. Outcomes\n${row}\n## 6. Risks`);
      assert.equal(outcome.outcome, `Keep ${syntax}`);
      assert.deepEqual(outcome.acceptance_criteria, [`Verify ${syntax}`]);
    }
    assert.equal(readMarkdownSprintScope(markdown.replace("Return errors", `Return ${syntax}`))[0].objective, `Return ${syntax}`);
  }
  for (const missing of ["<guardrail>", "<TBD>", "<TODO>", "PROJECT-<TBD>", "/api/<TODO>", "<guardrail cần điền>", ""]) {
    assert.throws(() => readMarkdownSprintScope(`## 5. Outcomes\n| O1 | Keep IDs | Check behavior | ${missing} |\n## 6. Risks`), { code: "SPRINT_MARKDOWN_SCOPE" });
  }
});
