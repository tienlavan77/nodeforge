// Proves the conversation, Coding UI, and API contracts are identical for conversation-created Markdown plans.
// Business purpose: an owner creates a plan in chat, sees the exact Node-rendered Markdown on the Coding page,
// approves it through POST /plans/<id>/<rev>/decisions plus /handoff, and the approved revision keeps handing
// off to Sprint Leader through the unchanged assertMarkdownSprintScope scope gate without ever starting RUN.
// This test-only ticket freezes those cross-boundary contracts (approved sections 2, 3.2.9, 3.4) with
// executable proof: Markdown remains the displayed and handed-off contract, the unchanged renderer is exercised
// before any expectation is stated, and the section 5 gate is asserted on unmodified production code.
// Technical description: AC-1 renders one canonical Architecture JSON payload through the unchanged renderer
// and the real SQLite Markdown plan store, then compares exact-byte SHA-256 digests and replay identity.
// AC-2/AC-4 load the real UI plan client module the Coding page bundles (ui/nextjs/lib/node-client.js) through
// esbuild plus a controlled transport, and prove its decisions and handoff request bodies bind the exact
// revision and SHA-256 the Node-rendered Markdown locked. AC-3 drives the real conversation approval service,
// plan handoff service, Sprint registry, and draft persistence so the scope gate runs inside the real handoff
// attempt, then re-asserts assertMarkdownSprintScope directly on the approved bytes. AC-2 and AC-4 additionally
// send the same conversation-created revision through the real authenticated plan router with the real owner
// credential, so a regression in route authentication, Markdown store selection, or decision and handoff request
// validation fails the submitted tests instead of hiding behind mocked server responses. Only external I/O and
// the scripted Architecture answer are mocked; Coding UI and validator production files are never modified.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createMarkdownPlanStore } from "../../src/modules/governance/markdown-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { createSprintPlanDraftPersistence } from "../../src/modules/governance/sprint-plan-draft-persistence.js";
import { readMarkdownSprintScope, assertMarkdownSprintScope } from "../../src/modules/governance/markdown-sprint-scope.js";
import { readArchitectureDecisions } from "../../src/modules/governance/architecture-owner-decisions.js";
import { createSprintOrchestrationService } from "../../src/application/sprint-orchestration-service.js";
import { createPlanHandoffService } from "../../src/application/plan-handoff-service.js";
import { createArchitectureClarificationStore } from "../../src/application/architecture-clarification-store.js";
import { createConversationPlanningService } from "../../src/application/conversation-planning-service.js";
import { createConversationPlanApprovalService } from "../../src/application/conversation-plan-approval-service.js";
import { createPlanOwnerAuth } from "../../src/modules/governance/plan-owner-auth.js";
import { routePlan } from "../../src/transport/http/forge-v1-plan-routes.js";
import { canonicalizeArchitecturePlanJSON, renderArchitecturePlanMarkdown, parseArchitecturePlanJSON } from "../../src/modules/governance/architecture-plan-json.js";

const PLAN_PAYLOAD = {
  title: "Contract plan", objective: "Keep conversation, Coding UI and API bytes identical.",
  background: "Owner created the plan in chat; discovery complete over the repository. Assumption: approval stays conversation-scoped.",
  scope: ["Rendered Markdown identity", "Decision and handoff contracts"],
  outcomes: [{ id: "O1", outcome: "Identical contract bytes", acceptance_criteria: ["The rendered Markdown bytes match their recorded SHA-256"], guardrails: ["Approval never starts RUN"] }],
  evidence: [{ path: "backend/src/application/conversation-plan-approval-service.js", location: "L1", fact: "Node alone records approval." }],
  assumptions: ["Owner reviews the rendered revision."], constraints: ["Markdown remains the handed-off contract"],
  risks: ["Stale revision approval"], verification: "Focused integration and browser tests."
};
const NO_QUESTIONS = '{"questions":[]}';
// An RFC 7396 patch that revises wording while keeping the outcome O1 approved scope identical.
const PATCH_JSON = JSON.stringify({ objective: "Keep conversation, Coding UI and API bytes identical across revisions." });

// Applies the unchanged owner-facing Markdown gates so only genuine renderer bytes can pass.
async function validateMarkdown(markdown) {
  if (!/^# Plan:\s*\S/.test(markdown) || !/^## 1\. /m.test(markdown) || !/^## 7\. /m.test(markdown)) throw Object.assign(new Error("bad frame"), { code: "ARCHITECTURE_PLAN_INVALID" });
  if (!/discovery complete/i.test(markdown) || !/assumption|unverified|unknown|uncertain/i.test(markdown)) throw Object.assign(new Error("incomplete discovery"), { code: "DISCOVERY_INCOMPLETE" });
  readMarkdownSprintScope(markdown);
}

// Builds real plan storage and the real conversation planning services around one temp project root.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "conversation-contract-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**", "node_modules/**"] });
  await fileService.atomicWrite({ path: "backend/src/application/conversation-plan-approval-service.js", content: "// evidence target\n", replace: true });
  const markdownPlanStore = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
  // Scripts only the external Architecture answer: clarification finds nothing, generation returns the payload, update returns the RFC 7396 patch.
  const planning = createConversationPlanningService({ projectId: "PROJECT-A", fileService, markdownPlanStore, validateMarkdown, sessions: createArchitectureClarificationStore({ projectId: "PROJECT-A", fileService }), requestArchitecture: async (prompt) => {
    const text = String(prompt);
    if (text.includes("Architecture clarification discovery")) return NO_QUESTIONS;
    if (text.includes("Architecture plan update")) return PATCH_JSON;
    return JSON.stringify(PLAN_PAYLOAD);
  } });
  return { root, database, fileService, markdownPlanStore, planning, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Projects the rendered outcome scope into one schema-valid Sprint draft for the unchanged gate.
function outcomeDraft(scope, sprintId, ticketId, title) {
  assert.equal(scope[0]?.kind, "outcome", "the contract plan must render outcome scope in section 5");
  return {
    id: sprintId, roadmap_id: `ROADMAP-${sprintId.split("-").pop()}`, project_id: "PROJECT-A", objective: "Identical contract bytes", exit_criteria: ["Pass"],
    tickets: [{ id: ticketId, title, objective: "Preserve the approved outcome", implementation_type: ["backend"], file_budget: 2, acceptance_criteria: [...scope[0].acceptance_criteria], outcome_refs: [scope[0].id], coverage: { [scope[0].id]: { criterion_refs: [...scope[0].acceptance_criteria], guardrail_refs: [...scope[0].guardrails], dependency_refs: [...(scope[0].mandatory_dependencies ?? [])] } }, verification_plan: scope[0].acceptance_criteria.map((_, index) => ({ kind: "test", criterion_ids: [`AC-${index + 1}`], test_path: "backend/tests/integration/conversation-plan-contract.test.js" })) }],
    human_plan: { outcome: "Identical contract bytes", in_scope: "Markdown contract", out_of_scope: "RUN authority", approach: "Prove with tests", components: ["contract tests"], risks: [], assumptions: [], open_questions: [], evidence_refs: ["Conversation plan"], acceptance_criteria: ["Pass"] }
  };
}

// AC-1: the unchanged renderer turns one canonical payload into one byte-stable Markdown document.
test("the same JSON payload renders deterministic Markdown bytes through the real store", async () => {
  const f = await fixture();
  try {
    const canonical = canonicalizeArchitecturePlanJSON(parseArchitecturePlanJSON(JSON.stringify(PLAN_PAYLOAD)));
    const anchorSha = sha256(canonical);
    const first = renderArchitecturePlanMarkdown({ plan: PLAN_PAYLOAD, planId: "PLAN-DET", revision: 1, sourceSha256: anchorSha });
    const second = renderArchitecturePlanMarkdown({ plan: JSON.parse(JSON.stringify(PLAN_PAYLOAD)), planId: "PLAN-DET", revision: 1, sourceSha256: anchorSha });
    assert.equal(first, second, "the unchanged renderer is byte-deterministic for one payload");
    await validateMarkdown(first);
    const created = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    const stored = await f.markdownPlanStore.getRevision({ planId: created.plan_id, revision: created.revision });
    assert.equal(sha256(stored.markdown), created.sha256, "the store digest binds the exact rendered bytes");
    assert.equal(stored.source_sha256, created.source_summary_sha256);
    const reread = await f.markdownPlanStore.getRevision({ planId: created.plan_id, revision: created.revision });
    assert.equal(reread.markdown, stored.markdown, "re-reading the locked revision returns the identical rendered bytes");
    assert.equal(reread.sha256, created.sha256);
  } finally { await f.close(); }
});

// AC-3: the approved conversation Markdown passes the unchanged section 5 scope gate directly.
test("the approved conversation Markdown passes the unchanged assertMarkdownSprintScope gate", async () => {
  const f = await fixture();
  try {
    const created = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    const stored = await f.markdownPlanStore.getRevision({ planId: created.plan_id, revision: created.revision });
    const scope = readMarkdownSprintScope(stored.markdown);
    assert.ok(scope.length >= 1, "section 5 carries approved scope");
    assert.equal(assertMarkdownSprintScope(stored.markdown, outcomeDraft(scope, "SPRINT-GATE", "TICKET-GATE-1", "Contract gate")).length, scope.length, "the unchanged gate admits the rendered scope");
  } finally { await f.close(); }
});

// AC-3 through the real server path: approval, decision recording, and handoff keep the gate and never start RUN.
test("real approval and handoff services pass the scope gate and replay on the conversation-created revision", async () => {
  const f = await fixture();
  try {
    await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    // Approve the conversation-updated head, whose stored anchor matches its authoritative decision record.
    const created = await f.planning.updateFromConversation({ text: "Update the plan", conversationId: "CONV-A" });
    assert.equal(created.revision, 2, "the update creates the next immutable revision");
    assert.equal(readArchitectureDecisions(created.markdown).source_path, created.source_summary_path, "the decision record binds the exact Node-owned anchor");
    const plans = createHumanPlanStore({ projectId: "PROJECT-A", database: f.database, fileService: f.fileService, markdownPlans: f.markdownPlanStore });
    const registry = createSprintRegistry({ projectId: "PROJECT-A", database: f.database, plans });
    const draft = createSprintPlanDraftPersistence({ projectId: "PROJECT-A", planStore: plans, markdownPlanStore: f.markdownPlanStore, sprintRegistry: registry });
    const agentRoleResolver = { resolveProfile: () => ({ agent_id: "LEADER-CONTRACT" }) };
    const orchestration = createSprintOrchestrationService({ sprintPlans: { getSprintById: () => { throw new Error("legacy reader must not run"); } }, sprintPlanStore: { save: () => { throw new Error("legacy projection must not be written"); } }, sprintRegistry: registry, draftPlan: draft, agentRoleResolver, agentGateway: { async stream() { throw new Error("legacy agent stream must not run"); } }, publisher: { publish: () => {} } });
    const scope = readMarkdownSprintScope(created.markdown);
    let leaderCalls = 0;
    const handoff = createPlanHandoffService({ projectId: "PROJECT-A", database: f.database, planStore: plans, markdownPlanStore: f.markdownPlanStore, sprintRegistry: registry, sprintOrchestration: orchestration, agentRoleResolver, sprintPlanLeader: { requestPlan: async () => { leaderCalls += 1; return outcomeDraft(scope, "SPRINT-CONTRACT", "TICKET-CONTRACT-1", "Keep contract bytes"); } } });
    const service = createConversationPlanApprovalService({ projectId: "PROJECT-A", markdownPlanStore: f.markdownPlanStore, sprintRegistry: registry, handoffApprovedPlan: (input) => handoff.handoff(input), announceApprovalIdentity: async () => {} });
    const first = await service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OWNER", approvalRevision: created.revision, approvalSha256: created.sha256 });
    assert.equal(first.status, "handed_to_sprint_leader", "the scope gate passed inside the real handoff attempt");
    assert.equal(first.run_started, false, "approval and handoff never start RUN");
    assert.equal(first.sha256, created.sha256, "the handoff reports the exact rendered digest");
    const decisions = f.database.all("SELECT * FROM markdown_plan_decisions");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].sha256, created.sha256, "the decision records the rendered bytes the owner reviewed");
    const approvedRevision = await f.markdownPlanStore.getRevision({ planId: created.plan_id, revision: created.revision });
    assert.equal(approvedRevision.status, "approved");
    assert.equal(approvedRevision.handoff_status, "completed");
    assert.equal(assertMarkdownSprintScope(approvedRevision.markdown, outcomeDraft(scope, "SPRINT-CONTRACT", "TICKET-CONTRACT-1", "Keep contract bytes")).length, scope.length, "the approved Markdown bytes still pass the unchanged gate after handoff");
    const replay = await service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OWNER", approvalRevision: created.revision, approvalSha256: created.sha256 });
    assert.equal(replay.status, "handed_to_sprint_leader");
    assert.equal(replay.replayed, true);
    assert.equal(leaderCalls, 1, "a duplicate delivery never repeats the Sprint Leader handoff");
    await assert.rejects(() => service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OWNER", approvalRevision: created.revision, approvalSha256: "f".repeat(64) }), { code: "PLAN_APPROVAL_STALE" }, "a mismatched checksum cannot approve the rendered revision");
    assert.equal(f.database.all("SELECT * FROM markdown_plan_decisions").length, 1);
  } finally { await f.close(); }
});

// AC-2 and AC-4: the real UI plan client's decisions and handoff payloads carry the captured identity.
test("the real UI plan client sends the captured revision identity to the decisions and handoff endpoints", async () => {
  const f = await fixture();
  const savedFetch = globalThis.fetch;
  try {
    const created = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    const storedRevision = await f.markdownPlanStore.getRevision({ planId: created.plan_id, revision: created.revision });
    assert.equal(storedRevision.format, "markdown", "the store hands the Coding page the Markdown contract document");
    const bundle = await build({ stdin: { contents: "export { createNodeClient } from './lib/node-client.js';", resolveDir: join(process.cwd(), "ui/nextjs"), loader: "js" }, bundle: true, write: false, format: "esm", platform: "neutral", define: { "process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL": '""', "process.env.NODE_ENV": '"test"', "process.env": "{}" } });
    const namespace = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
    const client = namespace.createNodeClient();
    assert.ok(client.decidePlan && client.handoffPlan && client.getPlanRevision, "the same client module the Coding page uses exposes the plan contract");
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input);
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ path: url.pathname, search: Object.fromEntries(url.searchParams), method: init.method ?? "GET", headers: init.headers ?? {}, body });
      if (url.pathname.endsWith("/decisions")) return Response.json({ ok: true, decision: body.decision, sha256: body.sha256 });
      if (url.pathname.endsWith("/handoff")) return Response.json({ ok: true, status: "handed_to_sprint_leader", sprint_id: "SPRINT-UI", plan_handoff: true, run_started: false });
      return Response.json({ ...storedRevision });
    };
    const revision = await client.getPlanRevision("PROJECT-A", created.plan_id, created.revision);
    assert.equal(revision.sha256, created.sha256, "the page reads the exact revision chat announced");
    assert.equal(revision.markdown, created.markdown, "the displayed contract is the Node-rendered Markdown");
    await client.decidePlan("PROJECT-A", revision, "approved", "OWNER-TOKEN", "looks right", "DECISION-UI-1");
    const decisionCall = calls.find((call) => call.path.endsWith(`/plans/${created.plan_id}/${created.revision}/decisions`));
    assert.ok(decisionCall, "the client posts to the decisions contract path");
    assert.equal(decisionCall.method, "POST");
    assert.equal(decisionCall.headers.authorization, "Bearer OWNER-TOKEN");
    assert.equal(decisionCall.body.sha256, created.sha256, "the decision binds the rendered checksum");
    assert.equal(decisionCall.body.decision_id, "DECISION-UI-1");
    assert.equal(Object.hasOwn(decisionCall.body, "selections"), false, "Markdown plans never send legacy selections");
    await client.handoffPlan("PROJECT-A", revision, "OWNER-TOKEN");
    const handoffCall = calls.find((call) => call.path.endsWith(`/plans/${created.plan_id}/${created.revision}/handoff`));
    assert.ok(handoffCall, "the client posts to the handoff contract path");
    assert.equal(handoffCall.body.sha256, created.sha256, "the handoff continues the exact reviewed identity");
    assert.equal(handoffCall.headers.authorization, "Bearer OWNER-TOKEN");
  } finally { globalThis.fetch = savedFetch; await f.close(); }
});

// AC-2 and AC-4 through the real authenticated routes: production routePlan, real owner credential, real
// Markdown store selection, real decision recording, and the real handoff admission for the same
// conversation-created revision. Route auth, store selection and request validation regressions must fail here.
test("the real plan routes authenticate and bind the conversation revision through decisions and handoff", async () => {
  const f = await fixture();
  try {
    await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    // Route the CURRENT conversation head produced through the real create-then-update chat flow, so the
    // handoff admission below sees the same decision-embedded Markdown the accepted approval path delivers.
    const created = await f.planning.updateFromConversation({ text: "Update the plan", conversationId: "CONV-A" });
    assert.equal(created.revision, 2, "the routed revision is the immutable conversation-created head");
    const plans = createHumanPlanStore({ projectId: "PROJECT-A", database: f.database, fileService: f.fileService, markdownPlans: f.markdownPlanStore });
    const registry = createSprintRegistry({ projectId: "PROJECT-A", database: f.database, plans });
    const draft = createSprintPlanDraftPersistence({ projectId: "PROJECT-A", planStore: plans, markdownPlanStore: f.markdownPlanStore, sprintRegistry: registry });
    const agentRoleResolver = { resolveProfile: () => ({ agent_id: "LEADER-ROUTE" }) };
    const orchestration = createSprintOrchestrationService({ sprintPlans: { getSprintById: () => { throw new Error("legacy reader must not run"); } }, sprintPlanStore: { save: () => { throw new Error("legacy projection must not be written"); } }, sprintRegistry: registry, draftPlan: draft, agentRoleResolver, agentGateway: { async stream() { throw new Error("legacy agent stream must not run"); } }, publisher: { publish: () => {} } });
    const scope = readMarkdownSprintScope(created.markdown);
    let leaderCalls = 0;
    const handoff = createPlanHandoffService({ projectId: "PROJECT-A", database: f.database, planStore: plans, markdownPlanStore: f.markdownPlanStore, sprintRegistry: registry, sprintOrchestration: orchestration, agentRoleResolver, sprintPlanLeader: { requestPlan: async () => { leaderCalls += 1; return outcomeDraft(scope, "SPRINT-ROUTE", "TICKET-ROUTE-1", "Keep contract bytes"); } } });
    const context = { projectId: "PROJECT-A", expectedProjectId: "PROJECT-A", planStore: plans, markdownPlanStore: f.markdownPlanStore, sprintRegistry: registry, planOwnerAuth: createPlanOwnerAuth({ token: "fixture-secret", ownerId: "OWNER" }), handoffApprovedPlan: (input) => handoff.handoff(input) };
    const parts = ["plans", created.plan_id, String(created.revision)];
    const routedRead = await routePlan({ ...context, method: "GET", parts, body: {} });
    assert.equal(routedRead.status, 200);
    assert.equal(routedRead.body.format, "markdown", "the authenticated GET selects the Markdown contract store for the conversation plan");
    assert.equal(routedRead.body.markdown, created.markdown, "the routed read returns the exact Node-rendered conversation Markdown");
    assert.equal(routedRead.body.sha256, created.sha256, "the routed read returns the rendered checksum the owner saw in chat");
    await assert.rejects(routePlan({ ...context, projectId: "PROJECT-B", method: "GET", parts, body: {} }), { code: "PROJECT_CONTEXT_CONFLICT" }, "a cross-project revision read is refused before the store is consulted");
    await assert.rejects(routePlan({ ...context, method: "POST", parts: [...parts, "decisions"], headers: {}, body: { project_id: "PROJECT-A", sha256: created.sha256, decision: "approved" } }), { code: "PLAN_OWNER_UNAUTHORIZED" }, "an unauthenticated decision never reaches the decision store");
    assert.equal((await f.markdownPlanStore.getRevision({ planId: created.plan_id, revision: created.revision })).status, "awaiting_human_approval", "the rejected decision left no approval side effect");
    const routedDecision = await routePlan({ ...context, method: "POST", parts: [...parts, "decisions"], headers: { authorization: "Bearer fixture-secret" }, body: { project_id: "PROJECT-A", sha256: created.sha256, source_sha256: created.source_summary_sha256, decision: "approved", comments: "looks right", decision_id: "DECISION-ROUTE-1" } });
    assert.equal(routedDecision.status, 201);
    assert.equal(routedDecision.body.approver_id, "OWNER", "the route records the authenticated owner, never a forged request identity");
    assert.equal(routedDecision.body.sha256, created.sha256, "the persisted decision binds the rendered checksum");
    const approvedRevision = await f.markdownPlanStore.getRevision({ planId: created.plan_id, revision: created.revision });
    assert.equal(approvedRevision.status, "approved");
    await assert.rejects(routePlan({ ...context, method: "POST", parts: [...parts, "handoff"], headers: { authorization: "Bearer fixture-secret" }, body: { project_id: "PROJECT-A", sha256: "f".repeat(64) } }), { code: "PLAN_APPROVAL_STALE" }, "a handoff checksum differing from the reviewed revision cannot admit the Sprint Leader");
    assert.equal(leaderCalls, 0, "the rejected handoff never reached Sprint Leader planning");
    await assert.rejects(routePlan({ ...context, method: "POST", parts: [...parts, "handoff"], headers: { authorization: "Bearer fixture-secret" }, body: { project_id: "PROJECT-A", sha256: created.sha256, actor: "FORGED" } }), { code: "PLAN_ACTION_INPUT_INVALID" }, "the handoff contract accepts only the reviewed project context and checksum");
    const routedHandoff = await routePlan({ ...context, method: "POST", parts: [...parts, "handoff"], headers: { authorization: "Bearer fixture-secret" }, body: { project_id: "PROJECT-A", sha256: created.sha256 } });
    assert.equal(routedHandoff.status, 200);
    assert.equal(routedHandoff.body.status, "handed_to_sprint_leader", "the unchanged scope gate passed inside the routed handoff attempt");
    assert.equal(routedHandoff.body.sha256, created.sha256, "the routed handoff reports the exact rendered digest");
    assert.equal(routedHandoff.body.run_started, false, "the routed handoff never starts RUN");
    assert.equal(leaderCalls, 1, "one routed handoff admits exactly one Sprint Leader draft");
    const handed = await f.markdownPlanStore.getRevision({ planId: created.plan_id, revision: created.revision });
    assert.equal(handed.handoff_status, "completed", "the route persisted the durable handoff receipt on the same revision");
    assert.equal(assertMarkdownSprintScope(handed.markdown, outcomeDraft(scope, "SPRINT-ROUTE", "TICKET-ROUTE-1", "Keep contract bytes")).length, scope.length, "the routed approved bytes still pass the unchanged section 5 gate");
  } finally { await f.close(); }
});
