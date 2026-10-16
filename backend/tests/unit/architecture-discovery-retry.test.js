// Verifies automatic discovery correction preserves confirmed decisions and never persists an invalid or stale plan.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clarificationFixture, planMarkdown } from "./architecture-clarification-fixture.js";
import { readArchitectureDecisions } from "../../src/modules/governance/architecture-owner-decisions.js";

const incomplete = planMarkdown.replace("Repository discovery complete.", "Discovery pending.");

// Confirms one explicit owner answer so retries exercise the same authenticated source-bound session.
async function confirmedInput(fixture) {
  const pending = await fixture.start();
  const session = await fixture.command.planningSessions.get(pending.session_id);
  const saved = await fixture.command.planningSessions.update(session.session_id, { expectedVersion: session.version, sourceSha256: session.source_sha256, selections: { STORAGE: "SERVER" }, notes: { STORAGE: "Keep server policy" } });
  return { text: `/plan-continue ${saved.session_id}`, conversationId: "CONV-A", approvedOwnerId: "OWNER", planningVersion: saved.version, planningSourceSha256: saved.source_sha256 };
}

// Completes missing discovery internally rather than sending owners into an ineffective reload cycle.
test("discovery correction retries once and keeps confirmed policy in the single unapproved plan", async (context) => {
  const fixture = await clarificationFixture(context);
  const input = await confirmedInput(fixture);
  const prompts = [];
  const result = await fixture.command.execute({ ...input, requestArchitecture: async (prompt, conversationId) => {
    assert.equal(conversationId, "CONV-A");
    prompts.push(prompt);
    return prompts.length === 1 ? incomplete : planMarkdown;
  } });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /DISCOVERY_INCOMPLETE/);
  assert.match(prompts[1], /read-only tools/);
  assert.match(prompts[1], /Keep server policy/);
  assert.equal(result.status, "awaiting_human_approval");
  assert.equal(result.run_started, false);
  assert.equal(fixture.records.length, 1);
  assert.equal(readArchitectureDecisions(fixture.records[0].markdown).decisions[0].option_id, "SERVER");
});

// Stops repeated invalid discovery after a finite correction and preserves the session for an explicit retry.
test("repeated discovery failure is bounded, stores no plan, and retains owner choices for retry", async (context) => {
  const fixture = await clarificationFixture(context);
  const input = await confirmedInput(fixture);
  let calls = 0;
  await assert.rejects(fixture.command.execute({ ...input, requestArchitecture: async () => { calls++; return incomplete; } }), { code: "DISCOVERY_INCOMPLETE" });
  assert.equal(calls, 2);
  assert.equal(fixture.records.length, 0);
  const session = await fixture.command.planningSessions.get(input.text.split(" ")[1]);
  assert.equal(session.status, "generation_failed");
  assert.equal(session.error_code, "DISCOVERY_INCOMPLETE");
  assert.equal(session.selections.STORAGE, "SERVER");
  await fixture.command.execute({ ...input, requestArchitecture: async () => planMarkdown });
  assert.equal(fixture.records.length, 1);
});

// Revalidates the source between provider attempts rather than correcting a plan against changed owner input.
test("source changes stop automatic discovery correction before another provider call", async (context) => {
  const fixture = await clarificationFixture(context);
  const input = await confirmedInput(fixture);
  let calls = 0;
  await assert.rejects(fixture.command.execute({ ...input, requestArchitecture: async () => {
    calls++;
    await writeFile(join(fixture.root, "workflows/input.md"), "Changed owner scope");
    return incomplete;
  } }), { code: "ARCHITECTURE_SOURCE_CHANGED" });
  assert.equal(calls, 1);
  assert.equal(fixture.records.length, 0);
});

// Leaves provider and malformed-plan failures visible instead of retrying unrelated operations automatically.
test("non-discovery generation failures never trigger automatic correction", async (context) => {
  for (const response of ["not a plan", null]) {
    const fixture = await clarificationFixture(context);
    const input = await confirmedInput(fixture);
    let calls = 0;
    await assert.rejects(fixture.command.execute({ ...input, requestArchitecture: async () => {
      calls++;
      if (response === null) throw Object.assign(new Error("Provider offline"), { code: "PROVIDER_OFFLINE" });
      return response;
    } }), { code: response === null ? "PROVIDER_OFFLINE" : "ARCHITECTURE_PLAN_INVALID" });
    assert.equal(calls, 1);
    assert.equal(fixture.records.length, 0);
  }
});
