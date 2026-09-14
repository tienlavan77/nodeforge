import assert from "node:assert/strict";
import test from "node:test";
import { classifyTicketComplexity } from "../../src/tools/ticket-complexity.js";
import { COMPLEXITY_CONFIG } from "../../src/tools/ticket-complexity.js";

test("checklist ticket with explicit component location classifies as simple", () => {
  const result = classifyTicketComplexity({
    title: "CODEX-DOC-002 Architecture Manager selector in Project Chat",
    objective: "Replace the Talk to NodeForge heading in the Project Chat column with an Architecture Manager selector listing only enabled Architecture Manager agents. No hard-coded agent list; preserve existing chat behavior without changing backend contracts.",
    acceptance_criteria: ["Selector replaces the heading in the Project Chat column", "Only role=Architecture Manager enabled agents listed", "No hard-coded agent ids"]
  });
  assert.equal(result.level, "simple");
  assert.equal(result.effort, "low");
  assert.equal(result.discovery_budget, 4);
  assert.equal(result.max_turns, 15);
  assert.deepEqual(result.thinking, { type: "enabled", budgetTokens: 2048 });
  assert.ok(result.reasoning.some((line) => line.includes("explicit component/file location")));
});

test("open-ended redesign with many criteria classifies as complex", () => {
  const result = classifyTicketComplexity({
    title: "Redesign sprint planning",
    objective: "Investigate and design a new API migration for multi-project support. Consider performance and security implications, propose alternatives.",
    acceptance_criteria: Array.from({ length: 8 }, (_, i) => `criterion ${i}`)
  });
  assert.equal(result.level, "complex");
  assert.equal(result.effort, "high");
  assert.equal(result.discovery_budget, 12);
  assert.deepEqual(result.thinking, { type: "adaptive" });
});

test("real backend scope classifies above simple", () => {
  const result = classifyTicketComplexity({
    title: "Add retry to worker queue",
    objective: "The job worker queue must retry failed jobs with backoff and expose a new endpoint for queue depth.",
    acceptance_criteria: ["Worker retries failed jobs", "New endpoint returns queue depth"]
  });
  assert.notEqual(result.level, "simple");
  assert.ok(result.reasoning.some((line) => line.includes("backend scope")));
});

test("path prefix mentions do not count as backend scope", () => {
  const result = classifyTicketComplexity({
    title: "Add summary comment to validate-schemas.mjs",
    objective: "Read backend/scripts/validate-schemas.mjs and prepend an English summary comment describing what the script validates.",
    acceptance_criteria: ["Comment at top of backend/scripts/validate-schemas.mjs describing the schema files checked"]
  });
  assert.ok(!result.reasoning.some((line) => line.includes("backend scope")), `unexpected backend scope reasoning: ${result.reasoning.join("; ")}`);
  assert.ok(!result.reasoning.some((line) => line.includes("open-ended")));
});

test("every complexity level exposes a complete budget config", () => {
  for (const level of ["simple", "moderate", "complex"]) {
    const config = COMPLEXITY_CONFIG[level];
    assert.ok(["low", "medium", "high"].includes(config.effort));
    assert.ok(Number.isInteger(config.discovery_budget) && config.discovery_budget > 0);
    assert.ok(Number.isInteger(config.max_turns) && config.max_turns > 0);
    assert.ok(config.thinking && typeof config.thinking.type === "string");
  }
});
