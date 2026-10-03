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
  const projected = projectMarkdownSprintScope(markdown, { id: "SPRINT-A", tickets: [{ id: "TICKET-A", title: "Wrong", objective: "Wrong", implementation_type: ["frontend"], file_budget: 1, acceptance_criteria: ["Wrong"] }, { id: "TICKET-B", dependencies: ["TICKET-OTHER"], candidate_files: ["other.js"] }] });
  assert.deepEqual(projected.tickets, [{ ...tickets[0], dependencies: [] }, tickets[1]]);
  assert.throws(() => projectMarkdownSprintScope(markdown, { tickets: [{ id: "TICKET-A" }] }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => projectMarkdownSprintScope(markdown, { tickets: [{ id: "TICKET-A" }, { id: "TICKET-A" }] }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.throws(() => projectMarkdownSprintScope(markdown.replace("| API | ≤ 2 files", "| Unknown work | ≤ 2 files"), { tickets: [{ id: "TICKET-A" }, { id: "TICKET-B" }] }), { code: "SPRINT_MARKDOWN_SCOPE" });
});
