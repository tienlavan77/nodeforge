// Business purpose: verifies the Owner handoff route executes one real checkpoint role through the shared AM-SE-RV service boundary. Technical description: creates a durable store and checkpoint, routes GET and POST through the Forge conversation route, and verifies the SE adapter call plus persisted result.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createAmSeHandoffStore } from "../../src/application/am-se-handoff-store.js";
import { createAmSeHandoffCheckpoint } from "../../src/application/am-se-handoff-checkpoint.js";
import { createAmSeHandoffService } from "../../src/application/am-se-handoff-service.js";
import { createForgeV1ConversationRoutes } from "../../src/transport/http/forge-v1-conversation-routes.js";
import { createPlanOwnerAuth } from "../../src/modules/governance/plan-owner-auth.js";

// Business purpose: prepares an isolated approved handoff with a real persistence store and checkpoint. Technical description: creates the source plan, initializes the execution baseline, and injects a controlled SE adapter while leaving the route and state transitions real.
async function fixture(t) {
  const root = await mkdtemp(`${tmpdir()}/am-se-route-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const fileService = createFileService({ projectRoot: root });
  const planJson = JSON.stringify({ title: "Route plan", objective: "Run one SE step", background: "test", scope: ["handoff"], constraints: ["approval"], assumptions: ["Owner approves"], outcomes: [{ id: "O1", outcome: "step", acceptance_criteria: ["saved"], guardrails: ["no bypass"] }], evidence: [{ path: "backend/src/application/am-se-handoff-service.js", location: "L1", fact: "The handoff service owns one checkpoint step." }], risks: [], verification: "test" });
  await fileService.atomicWrite({ path: "source.json", content: planJson, replace: false });
  const gitService = { getHead: async () => "a".repeat(40), status: async () => "", indexEntries: async () => "" };
  const store = createAmSeHandoffStore({ projectId: "PROJECT-ROUTE", fileService });
  const id = "HANDOFF-PLAN-ROUTE-R1";
  await store.create({ handoffId: id, planId: "PLAN-ROUTE", planRevision: 1, planSha256: "a".repeat(64), planSourcePath: "source.json", deliveryTarget: "se", amConversationId: "CONV-AM", seConversationId: "CONV-SE", rvConversationId: "CONV-RV", phase: "implementation", status: "running", round: 1 });
  const markdownPlanStore = { decide: async () => {}, list: () => [{ plan_id: "PLAN-ROUTE", revision: 1 }], assertApproved: async () => ({ source_path: "source.json", project_id: "PROJECT-ROUTE", decision: { approver_id: "OWNER" } }) };
  const checkpoint = createAmSeHandoffCheckpoint({ store, markdownPlanStore, fileService, gitService, projectId: "PROJECT-ROUTE" });
  await checkpoint.initialize(id, "OWNER");
  let seCalls = 0;
  const service = createAmSeHandoffService({ projectId: "PROJECT-ROUTE", fileService, markdownPlanStore, handoffStore: store, gitService, requestSystemEngineer: async ({ correlationId }) => { seCalls += 1; return { execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed", turn_completed: true }, text: "SE completed" }; } });
  const routes = createForgeV1ConversationRoutes({ handoffService: service, planOwnerAuth: createPlanOwnerAuth({ token: "secret", ownerId: "OWNER" }) });
  return { id, store, routes, seCalls: () => seCalls };
}

test("GET handoff then Run invokes SE adapter once and persists checkpoint result", async (t) => {
  const f = await fixture(t);
  const listed = await f.routes.routeConversation({ method: "GET", parts: ["handoffs"], url: new URL("http://forge.test/forge/v1/handoffs?project=PROJECT-ROUTE"), body: {}, projectId: "PROJECT-ROUTE", headers: {} });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items[0].handoff_id, f.id);
  const result = await f.routes.routeConversation({ method: "POST", parts: ["handoffs", f.id, "run"], url: new URL(`http://forge.test/forge/v1/handoffs/${f.id}/run?project=PROJECT-ROUTE`), body: { project_id: "PROJECT-ROUTE", approval_revision: 1, approval_sha256: "a".repeat(64) }, projectId: "PROJECT-ROUTE", headers: { authorization: "Bearer secret" } });
  assert.equal(result.status, 200);
  assert.equal(f.seCalls(), 1);
  const saved = await f.store.get(f.id);
  assert.ok(saved.checkpoint.results?.length, JSON.stringify(result.body));
  assert.equal(saved.checkpoint.results[0].step, "se");
  assert.equal(saved.checkpoint.results[0].text, "SE completed");
  assert.equal(saved.checkpoint.execution_status, "pending");
  assert.equal(saved.checkpoint.next_step, "rv");
});
