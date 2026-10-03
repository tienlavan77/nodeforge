// Verifies Sprint Leader work groups remain within the owner-approved Markdown table.
import assert from "node:assert/strict";
import test from "node:test";
import { assertMarkdownSprintScope, readMarkdownSprintScope } from "../../src/modules/governance/markdown-sprint-scope.js";

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
