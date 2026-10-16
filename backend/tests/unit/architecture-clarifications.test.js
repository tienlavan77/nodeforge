// Verifies Architecture asks before planning, persists explicit choices, rejects stale identity and prevents duplicated Sprint policy approval.
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clarificationFixture, question } from "./architecture-clarification-fixture.js";
import { readArchitectureDecisions, validateArchitectureQuestions } from "../../src/modules/governance/architecture-owner-decisions.js";
import { sprintArchitectureDecisions } from "../../src/modules/governance/sprint-architecture-decisions.js";
import { sprintPlanDraftContent } from "../../src/modules/governance/sprint-plan-draft.js";
import { approvedTicketDecisions } from "../../src/modules/governance/plan-decision-requests.js";
import { routeArchitectureClarifications } from "../../src/transport/http/forge-v1-clarification-routes.js";

// Saves a draft under the latest version without treating its recommended option as selected.
async function choose(command, session, selections = { STORAGE: "SERVER" }) {
  return command.planningSessions.update(session.session_id, { expectedVersion: session.version, sourceSha256: session.source_sha256, selections, notes: { STORAGE: "Đồng bộ nhiều thiết bị" } });
}

test("/plan waits without producing a plan or treating recommendations as owner answers", async (context) => {
  const { start, command, records, prompts, events, create } = await clarificationFixture(context);
  const result = await start();
  assert.equal(result.status, "awaiting_owner_decisions"); assert.equal(result.plan_id, undefined);
  assert.equal(records.length, 0); assert.equal(prompts.length, 1); assert.equal(result.run_started, false);
  assert.match(prompts[0], /SL decides within the Sprint Plan; AM decides within the approved system structure/);
  assert.match(prompts[0], /not ordinary lifecycle implementation details or operational tool\/provider failures/);
  const session = await command.planningSessions.get(result.session_id);
  assert.deepEqual(session.selections, {});
  assert.deepEqual((await create().planningSessions.list("CONV-A"))[0].questions, [question]);
  assert.equal(events.at(-1).event_type, "plan.request.awaiting_owner_decisions");
  assert.equal(events.some((event) => event.event_type === "plan.request.failed" || event.event_type === "plan.request.persisted"), false);
});

test("confirmed owner choices are written into plan bytes; response-lost retry creates no second plan", async (context) => {
  const { start, command, provider, records, prompts, fileService, create } = await clarificationFixture(context);
  const pending = await start(); const draft = await choose(command, await command.planningSessions.get(pending.session_id));
  const input = { text: `/plan-continue ${draft.session_id}`, conversationId: "CONV-A", approvedOwnerId: "OWNER-A", planningVersion: draft.version, planningSourceSha256: draft.source_sha256, requestArchitecture: provider };
  const result = await command.execute(input);
  assert.equal(result.status, "awaiting_human_approval"); assert.equal(records.length, 1);
  assert.match(prompts[1], /"id":"SERVER"/); assert.match(prompts[1], /Do not ask these decisions again/);
  const markdown = await fileService.readFile({ path: result.path });
  assert.match(markdown, /Owner decisions/); assert.match(markdown, /Theo tài khoản, cần API/);
  const record = readArchitectureDecisions(markdown);
  assert.equal(record.owner_id, "OWNER-A"); assert.equal(record.decisions[0].option_id, "SERVER");
  assert.equal(record.decisions[0].owner_note, "Đồng bộ nhiều thiết bị");
  const replay = await create().execute(input);
  assert.equal(replay.plan_id, result.plan_id); assert.equal(prompts.length, 2); assert.equal(records.length, 1);
  await assert.rejects(command.execute({ ...input, approvedOwnerId: "OTHER" }), { code: "ARCHITECTURE_SESSION_STALE" });
});

test("owner, version, conversation, checksum and complete supported choices are required", async (context) => {
  const { start, command, provider, records } = await clarificationFixture(context);
  const pending = await start(); const session = await command.planningSessions.get(pending.session_id);
  const input = { text: `/plan-continue ${session.session_id}`, conversationId: "CONV-A", approvedOwnerId: "OWNER", planningVersion: session.version, planningSourceSha256: session.source_sha256, requestArchitecture: provider };
  await assert.rejects(command.execute({ ...input, approvedOwnerId: null }), { code: "PLAN_OWNER_UNAUTHORIZED" });
  await assert.rejects(command.execute(input), { code: "ARCHITECTURE_SELECTION_REQUIRED" });
  for (const patch of [{ conversationId: "CONV-B" }, { planningVersion: 999 }, { planningSourceSha256: "b".repeat(64) }]) await assert.rejects(command.execute({ ...input, ...patch }), { code: "ARCHITECTURE_SESSION_STALE" });
  await assert.rejects(choose(command, session, { STORAGE: "UNKNOWN" }), { code: "ARCHITECTURE_SELECTION_INVALID" });
  await assert.rejects(choose(command, session, { STORAGE: "LOCAL", OTHER: "LOCAL" }), { code: "ARCHITECTURE_SELECTION_INVALID" });
  const saved = await choose(command, session);
  await assert.rejects(choose(command, session), { code: "ARCHITECTURE_SESSION_STALE" });
  await command.planningSessions.update(saved.session_id, { expectedVersion: saved.version, sourceSha256: saved.source_sha256, cancel: true });
  await assert.rejects(command.execute({ ...input, planningVersion: saved.version + 1 }), { code: "ARCHITECTURE_SESSION_STALE" });
  assert.equal(records.length, 0);
});

test("changed input requires fresh discovery before plan generation and is visible after reload", async (context) => {
  const { root, start, command, provider, records } = await clarificationFixture(context);
  const pending = await start(); const saved = await choose(command, await command.planningSessions.get(pending.session_id));
  await writeFile(join(root, "workflows/input.md"), "A different owner requirement\n");
  assert.equal((await command.planningSessions.list("CONV-A"))[0].status, "source_changed");
  await assert.rejects(command.execute({ text: `/plan-continue ${saved.session_id}`, conversationId: "CONV-A", approvedOwnerId: "OWNER", planningVersion: saved.version, planningSourceSha256: saved.source_sha256, requestArchitecture: provider }), { code: "ARCHITECTURE_SOURCE_CHANGED" });
  assert.equal(records.length, 0);
});

test("no questions proceeds directly to a source-bound draft, without claiming owner approval", async (context) => {
  const { start, records, prompts } = await clarificationFixture(context, []);
  const result = await start();
  assert.equal(result.status, "awaiting_human_approval"); assert.equal(prompts.length, 2);
  assert.deepEqual(readArchitectureDecisions(records[0].markdown).decisions, []);
  assert.equal(readArchitectureDecisions(records[0].markdown).owner_id, null);
});

test("provider failure retains confirmed choices and retries only generation", async (context) => {
  const { start, command, provider, records, prompts } = await clarificationFixture(context);
  const pending = await start(); const saved = await choose(command, await command.planningSessions.get(pending.session_id));
  const input = { text: `/plan-continue ${saved.session_id}`, conversationId: "CONV-A", approvedOwnerId: "OWNER", planningVersion: saved.version, planningSourceSha256: saved.source_sha256 };
  await assert.rejects(command.execute({ ...input, requestArchitecture: async () => { throw Object.assign(new Error("offline"), { code: "PROVIDER_OFFLINE" }); } }), { code: "PROVIDER_OFFLINE" });
  assert.equal((await command.planningSessions.get(saved.session_id)).status, "generation_failed");
  await command.execute({ ...input, requestArchitecture: provider });
  assert.equal(prompts.length, 2); assert.equal(records.length, 1);
});

test("approved Architecture policies reach Coder without a second questionnaire or waived executable checks", async (context) => {
  const { start, command, provider, records } = await clarificationFixture(context);
  const pending = await start(); const saved = await choose(command, await command.planningSessions.get(pending.session_id));
  await command.execute({ text: `/plan-continue ${saved.session_id}`, conversationId: "CONV-A", approvedOwnerId: "OWNER", planningVersion: saved.version, planningSourceSha256: saved.source_sha256, requestArchitecture: provider });
  const parent = { ...records[0], status: "approved", decision: { decision_id: "APPROVAL-A", decision: "approved", sha256: records[0].sha256, approver_id: "OWNER" } };
  const policies = sprintArchitectureDecisions(parent);
  const sprint = { objective: "Restore", tickets: [{ id: "TICKET-A", verification_plan: [{ kind: "browser", criterion_ids: ["AC-1"], assertions: ["Panel restores"] }] }], human_plan: { outcome: "Restored", in_scope: "UI", out_of_scope: "Backend", approach: "Use approved server policy", components: ["Coding"], risks: [], assumptions: [], open_questions: [], evidence_refs: [parent.plan_id], acceptance_criteria: ["Restore"] } };
  const content = sprintPlanDraftContent(sprint, { architectureDecisions: policies });
  assert.equal(content.decision_requests, undefined); assert.equal(content.ticket_specs[0].verification_plan[0].kind, "browser");
  const runtime = approvedTicketDecisions({ plan_id: "SP-A", revision: 1, sha256: "a".repeat(64), content }, "TICKET-A");
  assert.equal(runtime[0].option_id, "SERVER"); assert.equal(runtime[0].decision_id, "APPROVAL-A"); assert.deepEqual(runtime[0].criterion_ids, []);
  assert.throws(() => sprintPlanDraftContent({ ...sprint, human_plan: { ...sprint.human_plan, decision_requests: [question] } }, { architectureDecisions: policies }), { code: "ARCHITECTURE_REPLAN_REQUIRED" });
  assert.throws(() => sprintPlanDraftContent({ ...sprint, tickets: [{ id: "TICKET-A", verification_plan: [{ kind: "human" }] }] }), { code: "ARCHITECTURE_REPLAN_REQUIRED" });
});

test("editing a failed generation invalidates its sealed confirmation before retry", async (context) => {
  const { start, command, provider, records } = await clarificationFixture(context);
  const pending = await start(); const saved = await choose(command, await command.planningSessions.get(pending.session_id));
  const input = { text: `/plan-continue ${saved.session_id}`, conversationId: "CONV-A", approvedOwnerId: "OWNER", planningVersion: saved.version, planningSourceSha256: saved.source_sha256 };
  await assert.rejects(command.execute({ ...input, requestArchitecture: async () => { throw new Error("offline"); } }), /offline/);
  const failed = await command.planningSessions.get(saved.session_id);
  const edited = await command.planningSessions.update(failed.session_id, { expectedVersion: failed.version, sourceSha256: failed.source_sha256, selections: { STORAGE: "LOCAL" }, notes: { STORAGE: "Changed policy" } });
  assert.equal(edited.status, "awaiting_owner_decisions"); assert.equal(edited.confirmation_version, null);
  await assert.rejects(command.execute({ ...input, requestArchitecture: provider }), { code: "ARCHITECTURE_SESSION_STALE" });
  assert.equal(records.length, 0);
  await command.execute({ ...input, planningVersion: edited.version, requestArchitecture: provider });
  assert.equal(readArchitectureDecisions(records[0].markdown).decisions[0].option_id, "LOCAL");
});

test("clarification HTTP verifies owner and rejects foreign conversations before mutating or confirming", async (context) => {
  const { start, command } = await clarificationFixture(context);
  const pending = await start(); const session = await command.planningSessions.get(pending.session_id); let submissions = 0;
  const route = { method: "PATCH", parts: ["conversations", "CONV-A", "plan-clarifications", session.session_id], projectId: "PROJECT-A", conversation: { id: "CONV-A", project_id: "PROJECT-A", agent_id: "ARCH" }, headers: { authorization: "Bearer OWNER-TOKEN" }, body: { version: session.version, source_sha256: session.source_sha256, selections: { STORAGE: "LOCAL" }, notes: {}, approver_id: "FORGED" }, ownerChatService: { planningSessions: command.planningSessions, submit: async (input) => { assert.equal(input.approved_owner_id, "AUTHENTICATED"); submissions++; return { payload: { status: "awaiting_human_approval" } }; } }, planOwnerAuth: { verify: (headers) => { assert.equal(headers.authorization, "Bearer OWNER-TOKEN"); return "AUTHENTICATED"; } } };
  const result = await routeArchitectureClarifications(route); assert.equal(result.body.selections.STORAGE, "LOCAL");
  await routeArchitectureClarifications({ ...route, method: "POST", parts: [...route.parts, "confirm"] }); assert.equal(submissions, 1);
  await assert.rejects(routeArchitectureClarifications({ ...route, parts: ["conversations", "CONV-B", "plan-clarifications", session.session_id] }), { code: "PROJECT_CONTEXT_CONFLICT" });
  await assert.rejects(routeArchitectureClarifications({ ...route, planOwnerAuth: null }), { code: "PLAN_OWNER_AUTH_UNCONFIGURED" });
});

test("malformed duplicate questions and unsupported alternatives cannot enter a waiting session", () => {
  for (const questions of [[question, question], [{ ...question, options: [question.options[0]] }], [{ ...question, recommended_option_id: "UNKNOWN" }], [{ ...question, title: 7 }]]) assert.throws(() => validateArchitectureQuestions(questions), { code: "ARCHITECTURE_QUESTIONS_INVALID" });
});

test("an abandoned ready session without questions resumes generation rather than getting stuck", async (context) => {
  const { start, command, provider, records } = await clarificationFixture(context);
  const pending = await start(); const original = await command.planningSessions.get(pending.session_id);
  const ready = await command.planningSessions.create({ sourcePath: original.source_path, sourceSha256: original.source_sha256, conversationId: "CONV-A", questions: [] });
  assert.equal((await command.planningSessions.list("CONV-A")).find((session) => session.session_id === ready.session_id).status, "generation_failed");
  await command.execute({ text: `/plan-continue ${ready.session_id}`, conversationId: "CONV-A", approvedOwnerId: "OWNER", planningVersion: ready.version, planningSourceSha256: ready.source_sha256, requestArchitecture: provider });
  assert.equal(records.length, 1); assert.deepEqual(readArchitectureDecisions(records[0].markdown).decisions, []);
});
