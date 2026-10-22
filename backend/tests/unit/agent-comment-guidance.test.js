// Verifies approved O4 comment and code-budget guidance in real provider prompts and repository rulebooks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildCodexTicketPrompt, buildToolTicketPrompt, COMPLEXITY_FALLBACK } from "../../src/modules/supervisor/nodeforge-task-prompts.js";

const rulebooks = ["CLAUDE.md", "AGENTS.md", "workflows/agents/coder/README.md", "workflows/agents/reviewer/README.md"];
const ticket = {
  id: "TICKET-O4", title: "Align agent purpose-comment guidance", objective: "Apply approved comment and budget conventions",
  acceptance_criteria: ["Prompt conventions", "Rulebook conventions", "Prompt conventions", "Combined prompt and rulebook conventions"],
  vocabulary_hints: ["retry"],
  verification_plan: [{ criterion_ids: ["AC-1", "AC-2", "AC-3", "AC-4"], kind: "test", test_path: "backend/tests/unit/agent-comment-guidance.test.js" }]
};

// Checks shared policy meaning without locking line breaks or incidental Markdown formatting.
function assertGuidance(content) {
  const text = content.replace(/[`*_]/g, "").replace(/\s+/g, " ");
  assert.match(text, /detailed\s+(?:multiline\s+)?purpose comments/i);
  assert.match(text, /business purpose/i);
  assert.match(text, /technical description/i);
  assert.match(text, /entirely in English or entirely in Vietnamese/i);
  assert.match(text, /do not mix sentence structure between languages/i);
  assert.match(text, /Technical identifiers, tags and paths may remain unchanged/i);
  assert.match(text, /new files and new (?:functions\/symbols)|new files\/new symbols only/i);
  assert.match(text, /(?:do not|without)[^.]*rewrite historical comments/i);
  assert.match(text, /(?:every file[^.]*250\s+codelines|250\s+codelines[^.]*every file)/i);
  assert.match(text, /all file types/i);
  assert.match(text, /excluding comment-only and blank lines/i);
  assert.match(text, /physical totallines[^.]*source (?:reads|coordinates)/i);
  assert.match(text, /80 physical lines/i);
  assert.match(text, /(?:without secrets|never include secrets)/i);
  assert.doesNotMatch(text, /(?:short summary comment|same language as (?:the file's )?code|all file content in English|250-line (?:file )?limit|250 lines or fewer|under 250 lines|Markdown guidance does not consume)/i);
}

for (const [provider, buildPrompt] of [["Codex", buildCodexTicketPrompt], ["Claude", buildToolTicketPrompt]]) {
  for (const [mode, directCode, immutableScope] of [["standard", false, false], ["direct", true, false], ["immutable", false, true]]) {
    test(`${provider} ${mode}: AC-1 and duplicate AC-3 use approved effective comment guidance`, () => {
      const prompt = buildPrompt(ticket, null, ["backend/"], COMPLEXITY_FALLBACK, directCode, immutableScope);
      assertGuidance(prompt);
      assert.match(prompt, /vocabulary\/glossary\.md/);
      assert.match(prompt, /Never edit vocabulary\/glossary\.md/);
      assert.match(prompt, /AC-1, AC-2, AC-3, AC-4/);
      assert.match(prompt, /read_lines/);
      assert.match(prompt, /independent review/i);
      assert.match(prompt, /Stay inside ticket scope/i);
    });
  }
}

for (const path of rulebooks) {
  test(`${path}: AC-2 and composite AC-4 preserve consistent policy and role boundaries`, () => {
    const content = readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
    assertGuidance(content);
    assert.match(content, /vocabulary\/glossary\.md|naming/);
    assert.match(content, /scope|assigned ticket/i);
    if (path.includes("reviewer")) {
      assert.match(content, /Do not edit production code/);
      assert.match(content, /Never approve on a best-effort reconstruction/);
    } else if (path.includes("coder")) {
      assert.match(content, /Push only when explicitly requested/);
      assert.match(content, /Do not reset, revert, overwrite, or discard another agent's changes/);
    } else {
      assert.match(content, /Do not edit `vocabulary\/glossary\.md` yourself/);
      assert.match(content, /Never swallow errors in `catch`/);
    }
  });
}
