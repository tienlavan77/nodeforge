// Verifies discovery preambles preserve evidence without bypassing plan scope, owner choices or approval.
import assert from "node:assert/strict";
import test from "node:test";
import { parseArchitecturePlan } from "../../src/modules/governance/architecture-plan-response.js";
import { readArchitectureDecisions } from "../../src/modules/governance/architecture-owner-decisions.js";
import { clarificationFixture, planMarkdown } from "./architecture-clarification-fixture.js";

test("plain plans remain unchanged and discovery preambles are retained below the title", () => {
  assert.equal(parseArchitecturePlan(planMarkdown), planMarkdown.trim());
  const preamble = "**Repository discovery complete.** [Source: workflows/input.md] Unverified: browser behavior.";
  const parsed = parseArchitecturePlan(`${preamble}\n\n${planMarkdown}`);
  assert.ok(parsed.startsWith("# Plan: Restore panels\n\n" + preamble));
  assert.ok(parsed.includes("## 7. Nghiệm thu"));
});

test("missing, multiple, fenced or competing documents are rejected", () => {
  for (const raw of ["No plan available", `${planMarkdown}\n${planMarkdown}`, "```md\n" + planMarkdown + "```", "# Another document\n" + planMarkdown]) {
    assert.throws(() => parseArchitecturePlan(raw), { code: "ARCHITECTURE_PLAN_INVALID" });
  }
});

test("owner-confirmed generation preserves discovery evidence and decisions without auto-approval", async (context) => {
  const { start, command, records } = await clarificationFixture(context);
  const pending = await start();
  const session = await command.planningSessions.get(pending.session_id);
  const selected = await command.planningSessions.update(session.session_id, { expectedVersion: session.version, sourceSha256: session.source_sha256, selections: { STORAGE: "LOCAL" }, notes: {} });
  const preamble = "Repository discovery complete. [Source: workflows/input.md] Unverified: browser behavior.";
  const body = planMarkdown.replace("Repository discovery complete. [Source: workflows/input.md]", "Restore panels.").replace("Unverified: runtime behavior requires browser verification.", "Browser verification required.");
  const result = await command.execute({ text: `/plan-continue ${selected.session_id}`, conversationId: "CONV-A", approvedOwnerId: "OWNER", planningVersion: selected.version, planningSourceSha256: selected.source_sha256, requestArchitecture: async () => `${preamble}\n\n${body}` });
  assert.equal(result.status, "awaiting_human_approval");
  assert.equal(result.run_started, false);
  assert.equal(records.length, 1);
  assert.ok(records[0].markdown.includes(preamble));
  assert.equal(readArchitectureDecisions(records[0].markdown).decisions[0].option_id, "LOCAL");
});

test("normalization cannot bypass evidence, scope or plan-format gates", async (context) => {
  for (const [markdown, code] of [
    [planMarkdown.replace("Repository discovery complete.", "Discovery pending."), "DISCOVERY_INCOMPLETE"],
    [planMarkdown.replace("[Source: workflows/input.md]", ""), "DISCOVERY_INCOMPLETE"],
    [planMarkdown.replace("| 1 | Restore", "| X | Restore"), "SPRINT_MARKDOWN_SCOPE"],
    [planMarkdown.replace("## 7. Nghiệm thu", "## Acceptance"), "ARCHITECTURE_PLAN_INVALID"]
  ]) {
    const { command, records } = await clarificationFixture(context, []);
    await assert.rejects(command.execute({ text: "/plan workflows/input.md", conversationId: "CONV-A", requestArchitecture: async (prompt) => prompt.startsWith("Architecture clarification discovery") ? '{"questions":[]}' : `Discovery commentary.\n\n${markdown}` }), { code });
    assert.equal(records.length, 0);
  }
});
