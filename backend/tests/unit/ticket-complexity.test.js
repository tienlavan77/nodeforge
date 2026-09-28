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
  assert.equal(result.discovery_budget, 6);
  assert.equal(Object.hasOwn(result, "max_turns"), false);
  assert.deepEqual(result.thinking, { type: "enabled", budgetTokens: 2048 });
  assert.ok(result.reasoning.some((line) => line.includes("explicit component/file location")));
});

test("focused checklist with many criteria stays moderate", () => {
  const result = classifyTicketComplexity({
    title: "Remove effort field from Add Agent and Edit Agent modals",
    objective: "Edit the frontend to remove the effort field from both modals so it is no longer displayed or submitted.",
    acceptance_criteria: [
      "The effort input field is removed from the Add Agent modal UI",
      "The effort input field is removed from the Edit Agent modal UI",
      "Submitting the Add Agent form does not include an effort value",
      "Submitting the Edit Agent form does not include an effort value",
      "No broken references to the removed effort field remain",
      "The modals render correctly without layout issues"
    ]
  });
  assert.equal(result.level, "moderate");
  assert.equal(result.effort, "medium");
  assert.equal(result.discovery_budget, 12);
  assert.equal(Object.hasOwn(result, "max_turns"), false);
  assert.ok(result.reasoning.some((line) => line.includes("focused single-area")));
});
test("open-ended redesign with many criteria classifies as complex", () => {
  const result = classifyTicketComplexity({
    title: "Redesign sprint planning",
    objective: "Investigate and design a new API migration for multi-project support. Consider performance and security implications, propose alternatives.",
    acceptance_criteria: Array.from({ length: 8 }, (_, i) => `criterion ${i}`)
  });
  assert.equal(result.level, "complex");
  assert.equal(result.effort, "high");
  assert.equal(result.discovery_budget, 18);
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

test("out-of-scope backend text does not classify a documentation ticket as backend work", () => {
  const result = classifyTicketComplexity({
    title: "Baseline canonical UI and import graph",
    objective: "Document the active route in ui/nextjs/README.md. Target path: ui/nextjs/README.md. Out of scope: unrelated backend/auth/dispatch changes unless this ticket explicitly requires a contract change.",
    acceptance_criteria: ["README includes the route and import graph."],
    style: ["frontend", "docs"]
  });
  assert.ok(!result.reasoning.some((line) => line.includes("backend scope")));
});

test("every complexity level exposes a complete budget config", () => {
  for (const level of ["simple", "moderate", "complex"]) {
    const config = COMPLEXITY_CONFIG[level];
    assert.ok(["low", "medium", "high"].includes(config.effort));
    assert.ok(Number.isInteger(config.discovery_budget) && config.discovery_budget > 0);
    assert.equal(Object.hasOwn(config, "max_turns"), false);
    assert.ok(config.thinking && typeof config.thinking.type === "string");
  }
});
