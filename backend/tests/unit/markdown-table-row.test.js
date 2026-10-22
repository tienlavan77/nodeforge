// Prevents valid code examples in Architecture outcomes from breaking plan admission or losing approved criteria.
import assert from "node:assert/strict";
import test from "node:test";
import { splitMarkdownTableRow } from "../../src/modules/governance/markdown-table-row.js";
import { readMarkdownSprintScope } from "../../src/modules/governance/markdown-sprint-scope.js";

test("outcome O2 retains the owner-agent capability plan's complete logical-OR criterion", () => {
  const code = 'file === path || file.startsWith("${path}/")';
  const markdown = `## 5. Outcomes\n| Mã | Outcome | Acceptance | Guardrail |\n| --- | --- | --- | --- |\n| O1 | Read files | Read source | Preserve access |\n| O2 | Search nested files | validatePaths checks \`${code}\`; accept files and directories | Preserve role scope |\n## 6. Risks`;
  const rows = readMarkdownSprintScope(markdown);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].id, "O2");
  assert.deepEqual(rows[1].acceptance_criteria, [`validatePaths checks ${code}`, "accept files and directories"]);
  assert.deepEqual(rows[1].guardrails, ["Preserve role scope"]);
});

test("table parsing preserves literal pipes across code delimiter lengths and escaped prose", () => {
  for (const example of ['`a || b`', '`string | null`', '`/a|b/`', '``const value = `a|b`;``']) {
    assert.deepEqual(splitMarkdownTableRow(`| O2 | ${example} | Check behavior | Preserve scope |`), [" O2 ", ` ${example} `, " Check behavior ", " Preserve scope "]);
  }
  assert.deepEqual(splitMarkdownTableRow(String.raw`| O2 | A \| B | Check | Scope |`), [" O2 ", " A | B ", " Check ", " Scope "]);
  assert.deepEqual(splitMarkdownTableRow(String.raw`| O2 | A \\| B | Check | Scope |`), [" O2 ", " A " + String.fromCharCode(92).repeat(2), " B ", " Check ", " Scope "]);
  assert.deepEqual(splitMarkdownTableRow("| O2 | Search | Check | Scope"), [" O2 ", " Search ", " Check ", " Scope"]);
});

test("legacy work groups and five-column outcomes use the same pipe-safe parsing", () => {
  const legacy = "## 5. Tickets\n| 1 | Search | backend | Accept `file || directory` | — | ≤ 3 files | Preserve `string | null` |\n## 6. Risks";
  assert.equal(readMarkdownSprintScope(legacy)[0].objective, "Accept file || directory");
  assert.deepEqual(readMarkdownSprintScope(legacy)[0].acceptance_criteria, ["Preserve string | null"]);
  const outcomes = "## 5. Outcomes\n| O1 | Search | Match `a || b` | Preserve scope | |\n| O2 | Display | Render `string | null` | Preserve UI | O1 |\n## 6. Risks";
  assert.deepEqual(readMarkdownSprintScope(outcomes)[1].mandatory_dependencies, ["O1"]);
});

test("literal-pipe handling does not admit missing criteria, unfinished placeholders or extra columns", () => {
  for (const row of ["| O2 | Search | | Preserve scope |", "| O2 | Search | Match `a || b` | <guardrail> |", "| O2 | Search | Match | Guardrail | O1 | Extra |", "| O2 | Search | Match `a || b` | | O1 |", "| O2 | Search | Match `a || b | Preserve scope | "]) {
    assert.throws(() => readMarkdownSprintScope(`## 5. Outcomes\n${row}\n## 6. Risks`), { code: "SPRINT_MARKDOWN_SCOPE" });
  }
});
