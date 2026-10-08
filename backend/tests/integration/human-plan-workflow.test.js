// Verifies that only an intact, current, human-approved plan can authorize sprint execution.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { createPlanOwnerAuth } from "../../src/modules/governance/plan-owner-auth.js";
import { sprintPlanDraftContent, assertApprovedTicket } from "../../src/modules/governance/sprint-plan-draft.js";
import { assertSprintTicketMembership } from "../../src/modules/governance/sprint-plan-execution-gates.js";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";

const content = (ticket) => ({ objective: "Deliver a reviewed sprint", outcome: "A working feature", in_scope: "Backend and UI", out_of_scope: "Unrelated work", approach: "Implement and verify", components: ["backend"], tickets: [ticket], dependencies: [], risks: ["Source drift"], assumptions: [], open_questions: [], evidence_refs: [ticket], acceptance_criteria: ["Verification passes"] });

test("individual ticket scope is valid inside a multi-ticket Sprint", () => {
  const tickets = [{ id: "TICKET-A", title: "API", objective: "Ship API", acceptance_criteria: ["API works"] }, { id: "TICKET-B", title: "UI", objective: "Ship UI", acceptance_criteria: ["UI works"] }];
  const plan = { content: { tickets: tickets.map((ticket) => ticket.id), ticket_specs: tickets } };
  assert.doesNotThrow(() => assertApprovedTicket(plan, tickets[0]));
  assert.doesNotThrow(() => assertSprintTicketMembership(plan, tickets));
  assert.throws(() => assertSprintTicketMembership(plan, [tickets[0]]), { code: "SPRINT_PLAN_SCOPE" });
  assert.throws(() => assertApprovedTicket(plan, { ...tickets[0], objective: "Extra scope" }), { code: "TICKET_PLAN_SCOPE" });
});

// Creates disposable project storage so the test never changes live plans.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-human-plan-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true });
  const create = () => {
    const plans = createHumanPlanStore({ projectId: "PROJECT-A", database, fileService });
    return { plans, sprints: createSprintRegistry({ projectId: "PROJECT-A", database, plans }) };
  };
  return { root, database, fileService, create, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

test("plan review binds execution to exact revision and invalidates prior approval after replan", async () => {
  const f = await fixture();
  try {
    const { plans, sprints } = f.create();
    const first = await plans.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 0, content: content("TICKET-A") });
    await sprints.register({ sprintId: "SPRINT-A", position: 0, planId: first.plan_id, revision: first.revision });
    await assert.rejects(sprints.setStatus({ sprintId: "SPRINT-A", status: "ready" }), { code: "PLAN_APPROVAL_REQUIRED" });
    await assert.rejects(plans.decide({ planId: "PLAN-A", revision: 1, sha256: "bad", decision: "approved", approverId: "OWNER", actorRole: "project_owner" }), { code: "PLAN_DECISION_STALE" });
    await plans.decide({ planId: "PLAN-A", revision: 1, sha256: first.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
    await sprints.setStatus({ sprintId: "SPRINT-A", status: "ready" });
    assert.equal((await sprints.assertReady("SPRINT-A")).plan.sha256, first.sha256);
    const revised = await plans.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 1, content: { ...content("TICKET-A"), approach: "Revised implementation" } });
    await assert.rejects(sprints.assertReady("SPRINT-A"), { code: "PLAN_APPROVAL_REQUIRED" });
    await sprints.bindPlan({ sprintId: "SPRINT-A", planId: "PLAN-A", revision: 2 });
    assert.equal(sprints.get("SPRINT-A").status, "awaiting_human_approval");
    await assert.rejects(sprints.setStatus({ sprintId: "SPRINT-A", status: "ready" }), { code: "PLAN_APPROVAL_REQUIRED" });
    await plans.decide({ planId: "PLAN-A", revision: 2, sha256: revised.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
    await sprints.setStatus({ sprintId: "SPRINT-A", status: "ready" });
    assert.equal((await sprints.assertReady("SPRINT-A")).plan.content.approach, "Revised implementation");
  } finally { await f.close(); }
});

test("missing or tampered plan file fails closed across a restarted store", async () => {
  const f = await fixture();
  try {
    const { plans, sprints } = f.create();
    const plan = await plans.createRevision({ planId: "PLAN-B", sprintId: "SPRINT-B", expectedRevision: 0, content: content("TICKET-B") });
    await plans.decide({ planId: "PLAN-B", revision: 1, sha256: plan.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
    await sprints.register({ sprintId: "SPRINT-B", position: 0, planId: "PLAN-B", revision: 1 });
    await sprints.setStatus({ sprintId: "SPRINT-B", status: "ready" });
    assert.equal((await f.create().sprints.assertReady("SPRINT-B")).plan.sha256, plan.sha256);
    await f.fileService.atomicWrite({ path: plan.file_path, content: "{}\n", replace: true });
    await assert.rejects(f.create().sprints.assertReady("SPRINT-B"), { code: "PLAN_HASH_MISMATCH" });
    await f.fileService.deleteFile({ path: plan.file_path });
    await assert.rejects(f.create().sprints.assertReady("SPRINT-B"), { code: "PLAN_FILE_MISSING" });
  } finally { await f.close(); }
});

test("sprint dependencies and rejected plans cannot become ready", async () => {
  const f = await fixture();
  try {
    const { plans, sprints } = f.create();
    const a = await plans.createRevision({ planId: "PLAN-C1", sprintId: "SPRINT-C1", expectedRevision: 0, content: content("TICKET-C1") });
    const b = await plans.createRevision({ planId: "PLAN-C2", sprintId: "SPRINT-C2", expectedRevision: 0, content: content("TICKET-C2") });
    await plans.decide({ planId: "PLAN-C1", revision: 1, sha256: a.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
    await plans.decide({ planId: "PLAN-C2", revision: 1, sha256: b.sha256, decision: "rejected", approverId: "OWNER", actorRole: "project_owner" });
    await sprints.register({ sprintId: "SPRINT-C1", position: 0, planId: "PLAN-C1", revision: 1 });
    await sprints.register({ sprintId: "SPRINT-C2", position: 1, dependencies: ["SPRINT-C1"], planId: "PLAN-C2", revision: 1 });
    await assert.rejects(sprints.setStatus({ sprintId: "SPRINT-C2", status: "ready" }), { code: "PLAN_APPROVAL_REQUIRED" });
    const revised = await plans.createRevision({ planId: "PLAN-C2", sprintId: "SPRINT-C2", expectedRevision: 1, content: content("TICKET-C2") });
    await sprints.bindPlan({ sprintId: "SPRINT-C2", planId: "PLAN-C2", revision: 2 });
    await plans.decide({ planId: "PLAN-C2", revision: 2, sha256: revised.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
    await assert.rejects(sprints.setStatus({ sprintId: "SPRINT-C2", status: "ready" }), { code: "SPRINT_DEPENDENCIES_NOT_READY" });
    await sprints.setStatus({ sprintId: "SPRINT-C1", status: "ready" });
    await sprints.setStatus({ sprintId: "SPRINT-C1", status: "running" });
    await sprints.setStatus({ sprintId: "SPRINT-C1", status: "done" });
    await sprints.setStatus({ sprintId: "SPRINT-C2", status: "ready" });
    assert.deepEqual((await sprints.assertReady("SPRINT-C2")).sprint.dependencies, ["SPRINT-C1"]);
  } finally { await f.close(); }
});

test("Forge plan API requires a project-owner decision before a sprint becomes ready", async () => {
  const f = await fixture();
  try {
    const { plans, sprints } = f.create();
    const router = createForgeV1Router({ planStore: plans, sprintRegistry: sprints, expectedProjectId: "PROJECT-A", planOwnerAuth: createPlanOwnerAuth({ token: "fixture-secret", ownerId: "OWNER" }), sprintOrchestrationService: { run: ({ sprintId }) => ({ sprint_id: sprintId, state: "RUNNING" }) } });
    const request = (method, path, body = {}, token = null) => {
      const input = Readable.from([JSON.stringify(body)]);
      input.headers = token ? { authorization: `Bearer ${token}` } : {};
      return router.route(method, new URL(`http://localhost/forge/v1${path}?project=PROJECT-A`), input);
    };
    const created = await request("POST", "/plans", { plan_id: "PLAN-HTTP", sprint_id: "SPRINT-HTTP", content: { ...content("TICKET-HTTP"), ticket_specs: [{ id: "TICKET-HTTP", title: "Registry ticket", objective: "Render immutable scope", priority: "high" }] } });
    assert.equal(created.status, 201);
    assert.equal((await request("POST", "/sprints/registry", { sprint_id: "SPRINT-HTTP", position: 0, plan_id: "PLAN-HTTP", plan_revision: 1 })).body.status, "awaiting_human_approval");
    const registeredSprints = await request("GET", "/sprints");
    assert.deepEqual(registeredSprints.body.map(({ id, ticket_ids: ticketIds }) => ({ id, ticketIds })), [{ id: "SPRINT-HTTP", ticketIds: ["TICKET-HTTP"] }]);
    const registeredSprint = await request("GET", "/sprints/SPRINT-HTTP");
    assert.equal(registeredSprint.status, 200);
    assert.equal(registeredSprint.body.id, "SPRINT-HTTP");
    assert.deepEqual(registeredSprint.body.ticket_ids, ["TICKET-HTTP"]);
    assert.deepEqual(registeredSprint.body.tickets, [{ id: "TICKET-HTTP", title: "Registry ticket", objective: "Render immutable scope", priority: "high" }]);
    await assert.rejects(request("POST", "/sprint-registry", { sprint_id: "SPRINT-RETIRED", position: 1, plan_id: "PLAN-HTTP", plan_revision: 1 }), { code: "ROUTE_RETIRED" });
    await assert.rejects(request("POST", "/plans/PLAN-HTTP/1/decisions", { sha256: created.body.sha256, decision: "approved", actor: "OWNER", actor_role: "project_owner" }), { code: "PLAN_OWNER_UNAUTHORIZED" });
    await assert.rejects(request("POST", "/plans/PLAN-HTTP/1/decisions", { sha256: created.body.sha256, decision: "approved" }, "wrong-token"), { code: "PLAN_OWNER_UNAUTHORIZED" });
    const decision = await request("POST", "/plans/PLAN-HTTP/1/decisions", { sha256: created.body.sha256, decision: "approved", actor: "AGENT", actor_role: "agent" }, "fixture-secret");
    assert.equal(decision.body.approver_id, "OWNER");
    assert.equal(decision.body.sha256, created.body.sha256);
    assert.equal((await request("PUT", "/sprints/registry/SPRINT-HTTP/status", { status: "ready" })).body.status, "ready");
    await assert.rejects(request("PUT", "/sprints/registry/SPRINT-HTTP/status", { status: "done" }), { code: "SPRINT_STATUS_AUTHORITY" });
    assert.equal((await request("GET", "/plans/PLAN-HTTP/1")).body.status, "approved");
    assert.equal((await request("POST", "/sprints/SPRINT-HTTP/draft")).body.state, "RUNNING");
  } finally { await f.close(); }
});

test("Sprint Leader draft binds the exact ticket scope before implementation", async () => {
  const f = await fixture();
  try {
    const { plans, sprints } = f.create();
    const ticket = { id: "TICKET-DRAFT", title: "Change API", objective: "Return canonical errors", acceptance_criteria: ["No legacy fields"], dependencies: [], style: ["backend"] };
    const draft = await plans.createRevision({ planId: "PLAN-DRAFT", sprintId: "SPRINT-DRAFT", expectedRevision: 0, content: sprintPlanDraftContent({ objective: "Canonical errors", exit_criteria: ["No legacy fields"], tickets: [ticket], human_plan: { outcome: "Canonical errors", in_scope: "API", out_of_scope: "UI", approach: "Change error serialization", components: ["backend API"], risks: [], assumptions: [], open_questions: [], evidence_refs: ["TICKET-DRAFT"], acceptance_criteria: ["No legacy fields"] } }) });
    await sprints.register({ sprintId: "SPRINT-DRAFT", position: 0, planId: "PLAN-DRAFT", revision: 1 });
    await assert.rejects(sprints.assertReady("SPRINT-DRAFT"), { code: "PLAN_APPROVAL_REQUIRED" });
    await plans.decide({ planId: "PLAN-DRAFT", revision: 1, sha256: draft.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
    await sprints.setStatus({ sprintId: "SPRINT-DRAFT", status: "ready" });
    const { plan } = await sprints.assertReady("SPRINT-DRAFT");
    assert.doesNotThrow(() => assertApprovedTicket(plan, ticket));
    assert.throws(() => assertApprovedTicket(plan, { ...ticket, objective: "Unapproved work" }), { code: "TICKET_PLAN_SCOPE" });
  } finally { await f.close(); }
});

test("Sprint Leader cannot persist a review draft without concrete evidence", () => {
  assert.throws(() => sprintPlanDraftContent({ objective: "Ship", tickets: [{ id: "TICKET-X" }], exit_criteria: ["Done"] }), { code: "PLAN_DRAFT_INCOMPLETE" });
});

test("Sprint Leader list sections become canonical review text", () => {
  const draft = sprintPlanDraftContent({ objective: "Ship", tickets: [{ id: "TICKET-X" }], human_plan: { outcome: "Done", in_scope: ["API", "tests"], out_of_scope: ["UI"], approach: ["Edit", "Verify"], components: ["backend"], risks: [], assumptions: [], open_questions: [], evidence_refs: ["TICKET-X"], acceptance_criteria: ["Pass"] } });
  assert.equal(draft.in_scope, "API\ntests");
  assert.equal(draft.approach, "Edit\nVerify");
});

test("Plan owner decisions fail closed until a server credential is configured", () => {
  assert.throws(() => createPlanOwnerAuth({ ownerId: "OWNER" }).verify({ authorization: "Bearer user-supplied" }), { code: "PLAN_OWNER_AUTH_UNCONFIGURED" });
  assert.throws(() => createPlanOwnerAuth({ token: "server-secret", ownerId: "OWNER" }).verify({ authorization: "Bearer wrong" }), { code: "PLAN_OWNER_UNAUTHORIZED" });
  assert.equal(createPlanOwnerAuth({ token: "server-secret", ownerId: "OWNER" }).verify({ authorization: "Bearer server-secret" }), "OWNER");
});

test("registry may record an unscheduled sprint before its execution plan exists", async () => {
  const f = await fixture();
  try {
    const { sprints } = f.create();
    const record = await sprints.register({ sprintId: "SPRINT-PLANNED", position: 0 });
    assert.equal(record.status, "planned");
    assert.equal(record.plan_id, null);
    await assert.rejects(sprints.setStatus({ sprintId: "SPRINT-PLANNED", status: "ready" }), { code: "PLAN_APPROVAL_REQUIRED" });
  } finally { await f.close(); }
});

test("approval binds both canonical artifact and approved source checksums", async () => {
  const f = await fixture();
  try {
    const { plans } = f.create();
    const sourceBytes = "approved source\n";
    await f.fileService.atomicWrite({ path: "workflows/human-approve.md", content: sourceBytes });
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const plan = await plans.createRevision({ planId: "PLAN-SOURCE", expectedRevision: 0, sourcePath: "workflows/human-approve.md", sourceSha256, content: content("TICKET-SOURCE") });
    await assert.rejects(plans.decide({ planId: "PLAN-SOURCE", revision: 1, sha256: plan.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" }), { code: "PLAN_DECISION_STALE" });
    const decision = await plans.decide({ planId: "PLAN-SOURCE", revision: 1, sha256: plan.sha256, sourceSha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
    assert.equal(decision.source_sha256, sourceSha256);
    assert.deepEqual(await plans.decide({ planId: "PLAN-SOURCE", revision: 1, sha256: plan.sha256, sourceSha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner", decisionId: decision.decision_id }), decision);
    assert.equal((await plans.getRevision({ planId: "PLAN-SOURCE", revision: 1 })).source_path, "workflows/human-approve.md");
  } finally { await f.close(); }
});
