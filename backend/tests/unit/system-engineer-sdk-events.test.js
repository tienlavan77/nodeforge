// Verifies lossless public SE events and unchanged SDK behavior for other agent roles.
import assert from "node:assert/strict";
import test from "node:test";
import { withSystemEngineerEvents } from "../../src/application/system-engineer-sdk-events.js";
import { redactSystemEngineerEvent } from "../../src/shared/system-engineer-event-redaction.js";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";

// Supplies SDK events through the same callback contract used by Codex owner execution.
function gateway(events) {
  return { conversationMode: "thread", async execute(request) {
    for (const event of events) await request.onEvent(event);
    return { text: "Done" };
  } };
}

// Keeps only commands, caps oversized command text, and never retains tool output.
test("SE stores compact command records with unique ordered transcript identities", async () => {
  const command = `printf '${Array.from({ length: 251 }, (_, index) => `argument-${index}`).join(" ")}'`;
  const output = `${"line\n".repeat(10000)}OUTPUT-END`;
  const source = { type: "item.completed", item: { id: "tool-1", type: "command_execution", command, aggregated_output: output, exit_code: 0,
    fields: Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`field_${index}`, index])), values: Array.from({ length: 35 }, (_, index) => index) } };
  const events = [source, { type: "item.completed", item: { id: "reply-1", type: "agent_message", text: "Done" } }];
  const delivered = [];
  const observed = [];
  const sdk = withSystemEngineerEvents(gateway(events), { profile: { role: "system_engineer", agent_id: "SE", provider: "codex" },
    conversationId: "CHAT", correlationId: "RUN", eventSink: (event) => delivered.push(event) });
  assert.equal((await sdk.execute({ onEvent: (event) => observed.push(event) })).text, "Done");
  assert.deepEqual(observed, events);
  assert.equal(delivered[0].payload.sdk_event.entries[0].command, `${command.trim().match(/\S+/g).slice(0, 250).join(" ")} …`);
  assert.doesNotMatch(JSON.stringify(delivered), /OUTPUT-END|aggregated_output|field_44/);
  assert.deepEqual(delivered.map((event) => event.payload.sdk_sequence), [1, 2, 3]);
  assert.equal(new Set(delivered.map((event) => event.payload.activity_id)).size, 3);
  assert.deepEqual(delivered.at(-1).payload.sdk_event.entries.map((entry) => entry.type), ["command_execution", "text"]);
  assert.ok(delivered.every((event) => event.payload.conversation_id === "CHAT" && event.payload.correlation_id === "RUN"));
});

// Ensures public-event delivery does not wrap or loosen any non-SE SDK execution.
test("AM, SL, Coder and Reviewer keep their original SDK instance and callbacks", () => {
  const sdk = gateway([]);
  for (const role of ["architecture_manager", "sprint_leader", "coder", "reviewer"]) {
    assert.equal(withSystemEngineerEvents(sdk, { profile: { role }, eventSink: () => assert.fail("must not publish") }), sdk);
  }
});

// Removes hidden thinking, owner prompts, and tool results while retaining executable commands.
test("Claude transcript retains only tool commands", async () => {
  const output = `${"source\n".repeat(1000)}END`;
  const events = [
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "private reasoning" }, { type: "tool_use", name: "Bash", input: { command: "git status --short" } }] } },
    { type: "user", message: { content: [{ type: "text", text: "owner prompt" }, { type: "tool_result", tool_use_id: "read", content: output }] } },
    { type: "item.completed", item: { type: "reasoning", text: "private reasoning" } },
    { type: "system", subtype: "init", instructions: "private initialization" }
  ];
  const delivered = [];
  await withSystemEngineerEvents(gateway(events), { profile: { role: "system_engineer" }, conversationId: "CHAT", correlationId: "RUN", eventSink: (event) => delivered.push(event) }).execute({});
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].payload.sdk_event.entries[0].command, "git status --short");
  assert.doesNotMatch(JSON.stringify(delivered), /private reasoning|owner prompt|private initialization/);
});

// Credentials are still removed without replacing arbitrary source content or token usage.
test("SE redacts structured and embedded secrets without truncating public content", () => {
  const content = `${"safe source\n".repeat(1000)}Bearer abc.def token=hidden api_key=hidden2 password='hidden three' {"token":"json-hidden"} known-credential END`;
  const clean = redactSystemEngineerEvent({ content, token: "private", access_token: "private", input_tokens: 123, reasoning: "private" }, ["known-credential"]);
  assert.ok(clean.content.startsWith("safe source\n".repeat(1000)));
  assert.ok(clean.content.endsWith("[REDACTED] END"));
  assert.doesNotMatch(JSON.stringify(clean), /abc\.def|hidden|known-credential|private/);
  assert.equal(clean.input_tokens, 123);
});

// Exercises the actual Claude gateway callback after provider credential sanitization.
test("Claude forwards complete sanitized events only for the SE profile", async () => {
  for (const role of ["system_engineer", "architecture_manager", "coder", "reviewer", "sprint_leader"]) {
    const events = [];
    const content = `${"output\n".repeat(1000)}gateway-credential END`;
    const sdk = createClaudeSdkGateway({ configuration: { getById: () => ({ agent_id: "AGENT", role, enabled: true, status: "ready", gateway_url: "https://gateway.test", credential_ref: "ref" }) },
      credentialResolver: () => "gateway-credential", terminalOutput: { write() {} },
      queryFn: async function* () { yield { type: "user", message: { content: [{ type: "tool_result", content }] } }; } });
    await sdk.execute({ agentId: "AGENT", prompt: "Inspect", correlationId: "RUN", onEvent: (event) => events.push(event) });
    assert.equal(events.length, role === "system_engineer" ? 1 : 0);
    if (events.length) assert.equal(events[0].message.content[0].content, content.replace("gateway-credential", "[REDACTED]"));
  }
});

// Transcript output is owner-visible history, not new instructions or model context.
test("saved SE SDK events are not included in the next owner SDK prompt", async () => {
  let prompt;
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ agent_id: "SE", role: "system_engineer", provider: "codex", tool_mode: "builtin" }) },
    sdkGateways: { codex: { conversationMode: "thread", execute: async (request) => { prompt = request.prompt; return { text: "Done" }; } } },
    conversationStateStore: { create: async () => ({}) }, conversationMessages: { getByConversationId: () => [
      { message_type: "owner.message", correlation_id: "PRIOR", payload: { text: "Previous owner request" } },
      { message_type: "agent.activity", correlation_id: "PRIOR", payload: { text: "RAW-EVENT-SHOULD-NOT-BE-CONTEXT", sdk_event: { output: "TOOL-OUTPUT-SHOULD-NOT-BE-CONTEXT" } } }
    ] }, fallbackStream: async function* () {}, projectRoot: process.cwd() });
  for await (const chunk of stream({ agentId: "SE", payload: { text: "Next request" }, conversationId: "CHAT", correlationId: "NEXT" })) assert.equal(chunk.text, "Done");
  assert.match(prompt, /Previous owner request/);
  assert.doesNotMatch(prompt, /RAW-EVENT-SHOULD-NOT-BE-CONTEXT|TOOL-OUTPUT-SHOULD-NOT-BE-CONTEXT/);
});
