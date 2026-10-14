// Verifies Architecture progress commentary cannot break valid questions or bypass owner-choice validation.
import assert from "node:assert/strict";
import test from "node:test";
import { parseArchitectureQuestions } from "../../src/modules/governance/architecture-question-response.js";
import { clarificationFixture, question } from "./architecture-clarification-fixture.js";

for (const wrapper of ["raw", "fenced", "progress", "crlf"]) {
  test(`Architecture question parser accepts ${wrapper} JSON`, () => {
    const json = JSON.stringify({ questions: [question] });
    const text = wrapper === "raw" ? json : `${wrapper === "progress" ? "I'll inspect the repository.\n\nI've inspected the registry.\n\n" : ""}\`\`\`json\n${json}\n\`\`\``;
    assert.deepEqual(parseArchitectureQuestions(wrapper === "crlf" ? text.replaceAll("\n", "\r\n") : text), [question]);
  });
}

test("Architecture rejects malformed, ambiguous and invalid choices instead of generating an empty plan", () => {
  for (const raw of ["", "not JSON", '{"questions":', "{}", '{"questions":[{}]}', '```json\n{"questions":[]}\n```\n```json\n{"questions":[]}\n```', '```json\n{"questions":[]}\n```\nAnother answer']) {
    assert.throws(() => parseArchitectureQuestions(raw), { code: "ARCHITECTURE_QUESTIONS_INVALID" });
  }
  assert.deepEqual(parseArchitectureQuestions('{"questions":[]}'), []);
});

test("/plan persists valid questions after streamed discovery progress and still waits for the owner", async (context) => {
  const fixture = await clarificationFixture(context);
  const result = await fixture.command.execute({ text: "/plan workflows/input.md", conversationId: "CONV-A", requestArchitecture: async () => `Inspecting the repository.\n\n\`\`\`json\n${JSON.stringify({ questions: [question] })}\n\`\`\`` });
  assert.equal(result.status, "awaiting_owner_decisions");
  assert.equal(fixture.records.length, 0);
});
