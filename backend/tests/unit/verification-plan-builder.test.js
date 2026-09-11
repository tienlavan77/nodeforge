import assert from "node:assert/strict";
import test from "node:test";
import { buildVerificationPlan } from "../../src/modules/verification/verification-plan-builder.js";

test("builds an allowlisted UI verification plan", () => {
  const plan = buildVerificationPlan({ commitId: "abc123", filesChanged: [{ path: "ui/nextjs/app/page.jsx" }] });
  assert.equal(plan.commit_id, "abc123");
  assert.deepEqual(plan.checks.map(({ type, command }) => ({ type, command })), [
    { type: "lint", command: "pnpm --dir ui/nextjs lint" },
    { type: "build", command: "pnpm --dir ui/nextjs build" }
  ]);
});

test("builds a backend plan and optionally includes tests", () => {
  const plan = buildVerificationPlan({ commitId: "def456", filesChanged: ["backend/src/index.js"], includeTests: true, scope: "related" });
  assert.deepEqual(plan.checks.map(({ type }) => type), ["test", "lint", "typecheck"]);
  assert.deepEqual(plan.levels, ["related"]);
});

test("maps orchestration targeted scope to schema focused level", () => {
  const plan = buildVerificationPlan({ commitId: "targeted-1", filesChanged: ["ui/nextjs/app/page.jsx"], scope: "targeted" });
  assert.deepEqual(plan.levels, ["focused"]);
});
