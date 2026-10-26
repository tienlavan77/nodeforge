import assert from "node:assert/strict";
import test from "node:test";

import { createSprintPlanLeader } from "../../src/application/sprint-plan-leader.js";

// Covers evidence-backed file hints while leaving the Coder's edit scope open.
test("runner keeps only file references observed with Forge tools", async () => {
  const calls = [];
  const progress = [];
  const sdkGateway = {
    execute: async (args) => {
      calls.push(args);
      return { messages: [{ text: '```json\n{"id":"SPRINT-1","roadmap_id":"ROADMAP-1","project_id":"P1","objective":"Ship it","tickets":[{"title":"T","objective":"O","acceptance_criteria":["A"],"implementation_type":["backend"],"file_budget":4,"candidate_files":[{"path":"backend/src/example.js","role":"REFERENCE","reason":"Forge search found the relevant service"},{"path":"backend/src/guessed.js","role":"REFERENCE","reason":"Unverified guess"}]}],"exit_criteria":["Done"]}\n```' }] };
    }
  };
  const leader = createSprintPlanLeader({ sdkGateway, projectRoot: process.cwd(), logger: { info: (name, details) => progress.push({ name, details }) }, toolOptions: ({ discoveredPaths }) => { discoveredPaths.add("backend/src/example.js"); return { forgeTools: { definitions: [{ name: "search_tree" }] } }; } });
  const plan = await leader.requestPlan({ projectId: "P1", agentId: "AGENT-SL", brief: "sprint brief", correlationId: "CORR-1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, process.cwd());
  assert.deepEqual(calls[0].options.forgeTools.definitions.map(({ name }) => name), ["search_tree"]);
  assert.match(calls[0].prompt, /identify existing related files/);
  assert.match(calls[0].prompt, /implementation_type/);
  assert.match(calls[0].prompt, /exact original wording and language, including Vietnamese/);
  assert.match(calls[0].prompt, /change ONLY verification_plan/);
  assert.match(calls[0].prompt, /unique positive integer widths in CSS pixels/);
  assert.match(calls[0].prompt, /viewports:\[375,768,1440\]/);
  assert.match(calls[0].prompt, /fields are strictly limited to: criterion_ids, kind, test_path, scenario_path, assertions, viewports, notes/);
  assert.match(calls[0].prompt, /never description/);
  assert.doesNotMatch(calls[0].prompt, /numeric viewports/);
  assert.match(calls[0].prompt, /components MUST be an array of nonempty strings/);
  assert.match(calls[0].prompt, /outcome_coverage is not a Sprint Plan schema field/);
  assert.match(calls[0].prompt, /change ONLY human_plan.components/);
  assert.doesNotMatch(calls[0].prompt, /Write ALL field values/);
  assert.match(calls[0].prompt, /workflows\/agents\/sprint-leader\/README\.md/);
  assert.match(calls[0].prompt, /Sprint Leader agent rules/);
  assert.match(calls[0].prompt, /there is no fixed limit on Coder revision\/Reviewer cycles/);
  assert.match(calls[0].prompt, /Older repository documents prescribing such caps are superseded/);
  assert.doesNotMatch(calls[0].prompt, /independent-review requirement, retry limit/);
  assert.deepEqual(plan.tickets[0].implementation_type, ["backend"]);
  assert.equal(plan.id, "SPRINT-1");
  assert.equal(plan.tickets[0].candidate_files, undefined);
  assert.equal(plan.tickets[0].candidates_produced_by, undefined);
  assert.deepEqual(progress.map(({ name }) => name), ["sprint_leader.started", "sprint_leader.completed"]);
  assert.equal(progress[1].details.plan_id, "SPRINT-1");
  assert.equal(progress[1].details.discovered_paths, 1);
  assert.equal(JSON.stringify(progress).includes("sprint brief"), false);
});

test("runner throws without an SDK gateway", async () => {
  const leader = createSprintPlanLeader({ sdkGateway: null });
  await assert.rejects(() => leader.requestPlan({ projectId: "P1", agentId: "A", brief: "b", correlationId: "C" }), /requires an SDK gateway/);
});

// Keeps Codex sprint plans available when the SDK returns text instead of messages.
test("runner parses a Codex SDK sprint plan from text", async () => {
  const leader = createSprintPlanLeader({ sdkGateway: { execute: async () => ({ text: '```json\n{"id":"SPRINT-1","objective":"Ship it"}\n```', items: [] }) }, toolOptions: () => ({ tools: [] }) });
  const plan = await leader.requestPlan({ projectId: "P1", agentId: "AGENT-SL", brief: "ship it", correlationId: "CORR-1" });
  assert.equal(plan.id, "SPRINT-1");
});

test("runner returns undefined when SDK messages hold no plan JSON", async () => {
  const leader = createSprintPlanLeader({ sdkGateway: { execute: async () => ({ messages: [{ text: "no json here" }] }) }, toolOptions: () => ({ tools: [] }) });
  const plan = await leader.requestPlan({ projectId: "P1", agentId: "A", brief: "b", correlationId: "C" });
  assert.equal(plan, undefined);
});

// Canonicalizes provider prose before any caller receives the Sprint draft, without another model invocation.
test("runner preserves verification description as canonical notes", async () => {
  let calls = 0;
  const leader = createSprintPlanLeader({ sdkGateway: { execute: async () => {
    calls++;
    return { text: JSON.stringify({ id: "SPRINT-1", tickets: [{ acceptance_criteria: ["Lifecycle works"], verification_plan: [{ kind: "test", criterion_ids: ["AC-1"], test_path: "backend/tests/unit/lifecycle.test.js", description: "Verify lifecycle" }] }] }) };
  } } });
  const plan = await leader.requestPlan({ projectId: "P1", agentId: "SL", brief: "Lifecycle", correlationId: "CORR-NOTES" });
  assert.equal(calls, 1);
  assert.deepEqual(plan.tickets[0].verification_plan, [{ kind: "test", criterion_ids: ["AC-1"], test_path: "backend/tests/unit/lifecycle.test.js", notes: "Verify lifecycle" }]);
});

// Provider-written malformed hashes are replaced from the same request's trusted Forge metadata.
test("runner binds malformed contract hashes to request receipts without another SDK call", async () => {
  const source = { id: "SPRINT-HASH", tickets: [{ execution_policy: { contract_evidence: [{ path: "backend/src/example.js", sha256: "a".repeat(65), authority_quote: "Preserve the approved contract" }] } }] };
  let calls = 0;
  const leader = createSprintPlanLeader({ toolOptions: ({ readReceipts }) => {
    readReceipts.set("backend/src/example.js", { path: "backend/src/example.js", sha256: `sha256:${"b".repeat(64)}` }); return { tools: [] };
  }, sdkGateway: { execute: async () => { calls++; return { text: JSON.stringify(source) }; } } });
  const plan = await leader.requestPlan({ projectId: "P1", agentId: "SL", correlationId: "CORR-HASH" });
  assert.equal(calls, 1);
  assert.equal(plan.tickets[0].execution_policy.contract_evidence[0].sha256, "b".repeat(64));
  assert.equal(source.tickets[0].execution_policy.contract_evidence[0].sha256.length, 65);
});

// Legacy candidates can be repaired without replaying planning or granting provider tools.
test("retained draft repair calls the governed reader and skips the SDK", async () => {
  const source = { id: "SPRINT-HASH", tickets: [{ execution_policy: { contract_evidence: [{ path: "backend/src/example.js", sha256: "invalid", authority_quote: "Preserve the approved contract" }] } }] };
  const reads = [];
  const leader = createSprintPlanLeader({ sdkGateway: { execute: () => assert.fail("Must not invoke SDK") }, evidenceTools: ({ agentId, correlationId }) => {
    assert.equal(agentId, "SL"); assert.equal(correlationId, "CORR-HASH-CONTRACT-EVIDENCE");
    return { registry: { read_file: { execute: async (input) => { reads.push(input); return { path: input.path, sha256: `sha256:${"c".repeat(64)}` }; } } } };
  } });
  const plan = await leader.repairContractEvidence({ plan: source, agentId: "SL", correlationId: "CORR-HASH" });
  assert.deepEqual(reads, [{ path: "backend/src/example.js", offset: 1, limit: 1 }]);
  assert.equal(plan.tickets[0].execution_policy.contract_evidence[0].sha256, "c".repeat(64));
});
