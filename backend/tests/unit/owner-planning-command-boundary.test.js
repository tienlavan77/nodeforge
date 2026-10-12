// Ensures backend-owned planning commands never fall through to chat or grant agents artifact-writing tools.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";
import { createOwnerChatCommandService } from "../../src/application/owner-chat-command-service.js";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";

// Creates a standalone owner command message without extra instruction text.
function input(text) {
  return { message_id: "MSG-A", project_id: "PROJECT-A", conversation_id: "CONV-A", correlation_id: "CORR-A", agent_id: "architect", timestamp: "2026-10-12T00:00:00Z", payload: { text } };
}

// Checks missing command configuration fails closed instead of dispatching a planning command as chat.
test("standalone planning commands cannot fall through when command service is unavailable", async () => {
  for (const text of ["/summary", " /SUMMARY ", "/plan SUMMARY-A", "/approve PLAN-A"]) {
    let launched = false;
    const service = createOwnerChatService({
      bus: { send: () => {}, sendFast: () => {} },
      agentStream: async function* () { launched = true; yield { text: "must not launch" }; },
    });
    const result = await service.submit(input(text));
    assert.equal(result.message_type, "owner.command.error");
    assert.equal(result.payload.error.code, "owner_command_unavailable");
    assert.equal(launched, false);
  }
});

// Confirms standalone summary routing does not depend on the configurable command predicate.
test("exact summary goes to command service even if its predicate returns false", async () => {
  let executions = 0; let launched = false;
  const service = createOwnerChatService({
    bus: { send: () => {}, sendFast: () => {} },
    commandService: { isCommand: () => false, execute: async ({ text }) => { executions++; assert.equal(text, "/summary"); return { status: "created" }; } },
    agentStream: async function* () { launched = true; yield { text: "must not launch" }; },
  });
  const result = await service.submit(input("/summary"));
  assert.equal(result.message_type, "owner.command.result");
  assert.equal(executions, 1);
  assert.equal(launched, false);
});

// Models the SDK-facing file service without allowing it to write summary artifacts.
function fileService() {
  return { readFile: async () => "# Source", readForIndex: async () => "# Source", atomicWrite: async () => assert.fail("agent must not write"), deleteFile: async () => assert.fail("agent must not delete"), listDirectories: async () => [], listFiles: async () => [] };
}

// Verifies every supported provider receives only read tools during backend-owned planning commands.
test("planning command tools are read-only across providers while ordinary Architecture chat keeps document tools", async () => {
  for (const provider of ["openai", "codex", "claude", "anthropic", "ollama"]) {
    const requests = [];
    const stream = createOwnerSdkStream({
      agentConfiguration: { getById: () => ({ agent_id: "architect", role: "architecture_manager", provider }) },
      sdkGateways: { [provider]: { conversationMode: provider === "codex" ? "thread" : "history", execute: async (request) => { requests.push(request); return { text: "content" }; } } },
      fallbackStream: async function* () {}, fileService: fileService(), projectRoot: process.cwd(),
    });
    for (const planning of [true, false]) {
      for await (const chunk of stream({ agentId: "architect", payload: { text: "planning content", planning_input_only: planning }, correlationId: `CORR-${planning}`, conversationId: "CONV-A" })) assert.equal(chunk.text, "content");
    }
    const tools = requests[0].options.forgeTools;
    assert.deepEqual(tools.definitions.map(({ name }) => name), ["search_tree", "list_files", "search_text", "read_file", "read_lines"]);
    for (const name of ["write_diff", "edit_diff", "delete_file", "commit_changes", "push_commit", "run_check"]) assert.equal(tools.registry[name], undefined, `${provider}: ${name}`);
    assert.match(requests[0].prompt, /NodeForge validates and saves the artifact/);
    assert.doesNotMatch(requests[0].prompt, /For architecture writing, use write_diff/);
    if (["claude", "anthropic"].includes(provider)) {
      assert.equal(requests[0].options.allowedTools.includes("mcp__forge__write_diff"), false);
      assert.equal(requests[0].options.allowedTools.includes("mcp__forge__read_file"), true);
    }
    assert.ok(requests[1].options.forgeTools.registry.write_diff);
  }
});

// Exercises the real command handler through chat to prove backend alone persists a validated summary.
test("standalone summary returns its backend-created artifact identity", async () => {
  const writes = []; const calls = [];
  const markdown = "# Discussion Summary\n## Goals\nReview. [Source: backend/src/application/owner-chat-command-service.js]\n## In Scope\nPlanning.\n## Out of Scope\nExecution.\n## Decisions\nAwait owner.\n## Assumptions\nAssumption: scope.\n## Risks\nUnknown dependencies.\n## Open Questions\nWhich test?";
  const commandService = createOwnerChatCommandService({
    projectId: "PROJECT-A", fileService: { readFile: async () => "", atomicCreate: async (write) => writes.push(write) },
    planStore: { createRevision: async () => {}, assertExecutable: async () => {} },
  });
  const chat = createOwnerChatService({
    bus: { send: () => {}, sendFast: () => {} }, commandService,
    agentStream: async function* (request) { calls.push(request); yield { text: markdown }; },
  });
  const result = await chat.submit(input("/summary"));
  assert.equal(result.message_type, "owner.command.result");
  assert.equal(result.payload.status, "created");
  assert.equal(result.payload.execution_authorized, false);
  assert.equal(calls[0].payload.planning_input_only, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, result.payload.path);
  assert.equal(writes[0].content, `${markdown}\n`);
  assert.match(result.payload.path, /^\.forge\/runtime\/nf\/summary\/SUMMARY-.+\.md$/);
});
