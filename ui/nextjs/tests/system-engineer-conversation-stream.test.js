// Exercises the real SSE hook, saved-history hook and JSX renderer for the SE transcript.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

// Loads the production hook with controlled React state, without a browser or network.
async function loadModule(path, react) {
  const compiled = await build({ entryPoints: [path], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/*"] });
  const result = { exports: {} };
  const require = createRequire(new URL("../package.json", import.meta.url));
  new Function("require", "module", "exports", compiled.outputFiles[0].text)((name) => name === "react" && react ? react : require(name), result, result.exports);
  return result.exports;
}

// Supplies a transcript-bearing event distinct from ordinary monitor notifications.
function event(id, conversationId = "CHAT") {
  return { project_id: "PROJECT", event_id: id, event_type: "agent.activity", timestamp: "2026-10-22T00:00:00Z",
    payload: { activity_id: id, agent_id: "SE", agent_role: "system_engineer", conversation_id: conversationId, correlation_id: "RUN",
      sdk_event: { type: "command_execution", command: "printf" } } };
}

// Tests actual hook wiring so full transcript entries reach chat as well as the existing monitor.
test("SSE hook appends only matching project/conversation SE events and ignores replays", async () => {
  let listener;
  let messages = [];
  let activities = [];
  let cleanup;
  const { useProjectEventStream } = await loadModule("ui/nextjs/lib/home-page-event-stream.js", { useRef: (value) => ({ current: value }), useEffect: (effect) => { cleanup = effect(); } });
  useProjectEventStream({ client: { connectProjectStream: (options) => { listener = options.onEvent; return { close() {} }; } }, projectId: "PROJECT",
    activeConversationIdRef: { current: "CHAT" }, agentDirectoryRef: { current: [] }, agentDisplayName: () => "Engineer",
    setMessages: (update) => { messages = update(messages); }, setAgentActivities: (update) => { activities = update(activities); }, setAgentTyping() {} });
  listener(event("ONE"));
  listener(event("ONE"));
  listener(event("OTHER-CHAT", "OTHER"));
  listener({ ...event("OTHER-PROJECT"), project_id: "OTHER" });
  const ordinary = event("MONITOR"); delete ordinary.payload.agent_role;
  listener(ordinary);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].se_event.command, "printf");
  assert.equal(activities.length, 4);
  const text = event("TEXT"); text.payload.sdk_event = { type: "agent_message", text: "Hello" };
  listener(text);
  listener({ project_id: "PROJECT", event_type: "conversation.message.delta", payload: { conversation_id: "CHAT", correlation_id: "RUN", chunk: "Hello", agent_id: "SE" } });
  assert.equal(messages.length, 2);
  assert.equal(messages.filter((message) => message.se_event).length, 1);
  cleanup();
});

// Commands and response text can arrive on separate SSE event types but share one event-time ordering.
test("SSE orders System Engineer commands and response text by event timestamp", async () => {
  let listener;
  let messages = [];
  let cleanup;
  const { useProjectEventStream } = await loadModule("ui/nextjs/lib/home-page-event-stream.js", { useRef: (value) => ({ current: value }), useEffect: (effect) => { cleanup = effect(); } });
  useProjectEventStream({ client: { connectProjectStream: (options) => { listener = options.onEvent; return { close() {} }; } }, projectId: "PROJECT",
    activeConversationIdRef: { current: "CHAT" }, agentDirectoryRef: { current: [] }, agentDisplayName: () => "Engineer",
    setMessages: (update) => { messages = update(messages); }, setAgentActivities() {}, setAgentTyping() {} });
  const command = event("COMMAND"); command.timestamp = "2026-10-22T00:00:02Z";
  listener(command);
  listener({ project_id: "PROJECT", event_id: "TEXT", event_type: "conversation.message.delta", timestamp: "2026-10-22T00:00:01Z",
    payload: { conversation_id: "CHAT", correlation_id: "RUN", chunk: "Inspecting the workspace", agent_id: "SE" } });
  assert.deepEqual(messages.map((message) => message.text), ["Inspecting the workspace", "printf"]);
  cleanup();
});

// Verifies history conversion retains the same SDK object and activity identity as live events.
test("saved conversation hook restores full events and paginates earlier events", async () => {
  const states = [];
  let cursor = 0;
  const saved = [event("FIRST"), event("SECOND")].map((entry) => ({ id: `SAVED-${entry.event_id}`, type: "agent.activity", kind: "system", agent_id: "SE",
    conversation_id: "CHAT", correlation_id: "RUN", timestamp: entry.timestamp, content: entry.payload }));
  const { useConversationMessageHistory } = await loadModule("ui/nextjs/lib/use-conversation-message-history.js", {
    useRef: (value) => ({ current: value }), useLayoutEffect() {}, useState: (initial) => {
      const index = cursor++; states[index] = initial;
      return [initial, (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    }
  });
  const calls = [];
  const hook = useConversationMessageHistory({ projectId: "PROJECT", chatMessagesRef: { current: { scrollHeight: 100, scrollTop: 0 } }, agentDirectoryRef: { current: [] }, agentDisplayName: () => "SE",
    client: { getConversationMessages: async (input) => { calls.push(input); return input.cursor ? { items: [saved[0]], next_cursor: null } : { items: [saved[1]], next_cursor: "1" }; } } });
  await hook.loadConversationMessages("CHAT");
  assert.equal(states[0][0].id, "SECOND");
  await hook.loadEarlierMessages();
  assert.equal(states[0].length, 2);
  assert.equal(calls[1].cursor, "1");
  assert.deepEqual(states[0][0].se_event, saved[0].content.sdk_event);
});

// The renderer never displays command output, even when a historic record contains it.
test("SE renderer shows only a command", async () => {
  const { SystemEngineerEvent } = await loadModule("ui/nextjs/components/system-engineer-event.jsx");
  const output = `${"long output\n".repeat(5000)}<script>alert(1)</script>OUTPUT-END`;
  const html = renderToStaticMarkup(createElement(SystemEngineerEvent, { value: { type: "command_execution", command: "git diff --check", aggregated_output: output } }));
  assert.match(html, /git diff --check/);
  assert.doesNotMatch(html, /OUTPUT-END|long output|script/);
});

// Command events must read like the CLI, not expose the SDK envelope as a field tree.
test("SE command renderer shows the command without output or event metadata", async () => {
  const { SystemEngineerEvent } = await loadModule("ui/nextjs/components/system-engineer-event.jsx");
  const command = "git status --short; sed -n '1,75p' ui/nextjs/components/system-engineer-event.jsx";
  const value = { type: "item.completed", item: { type: "command_execution", command, aggregated_output: "first\nsecond\n", exit_code: 0 } };
  const html = renderToStaticMarkup(createElement(SystemEngineerEvent, { value }));
  assert.match(html, /git status --short; sed -n/);
  assert.doesNotMatch(html, /first\nsecond\n|item.completed|command_execution|aggregated_output|exit_code|<dl|<dt|<dd/);
});

// Launcher quotes are presentation syntax, while quoted arguments and environment values belong to the command.
test("SE command display unwraps quoted shell payloads without truncating bare commands", async () => {
  const { systemEngineerCommandText } = await loadModule("ui/nextjs/components/system-engineer-event.jsx");
  const command = 'TMPDIR="$PWD/.nodeforge/test-tmp" OPENSSL_CONF=/dev/null node --test --test-reporter=spec backend/tests/unit/system-engineer-sdk-events.test.js backend/tests/unit/system-engineer-conversation-persistence.test.js backend/tests/unit/owner-builtin-tools.test.js backend/tests/unit/owner-sdk-tools.test.js ui/nextjs/tests/system-engineer-conversation-stream.test.js';
  const cases = [
    ["/bin/bash -lc 'git diff --check'", "git diff --check"],
    ['sh -c "git status --short"', "git status --short"],
    ["'git diff --stat'", "git diff --stat"],
    ['"git diff --stat"', "git diff --stat"],
    [`/bin/bash -lc '${command}'`, command],
    [String.raw`bash -lc "printf '%s' \"hello\""`, `printf '%s' "hello"`],
    [command, command],
    ["sed -n '1,80p' source.js", "sed -n '1,80p' source.js"],
    ['printf "%s" "hello"', 'printf "%s" "hello"'],
    ["bash -lc 'git diff' && printf done", "bash -lc 'git diff' && printf done"],
    ["bash -lc 'git diff", "bash -lc 'git diff"],
  ];
  for (const [input, expected] of cases) assert.equal(systemEngineerCommandText(input), expected, input);
});

// Live and restored turns share an expanded, accessible command block and never mutate the saved SDK command.
test("SE live and saved commands default open with a dot and RAN, preserving safe display", async () => {
  const { SystemEngineerEvent, systemEngineerEventText } = await loadModule("ui/nextjs/components/system-engineer-event.jsx");
  const command = '/bin/bash -lc \'printf "<script>alert(1)</script>"\'';
  const entry = Object.freeze({ id: "COMMAND", type: "command_execution", command });
  for (const status of ["in_progress", "completed"]) {
    const html = renderToStaticMarkup(createElement(SystemEngineerEvent, { value: { type: "conversation_turn", status, entries: [entry] } }));
    assert.match(html, /<details class="system-engineer-command" open="">/);
    assert.match(html, /<summary><span class="system-engineer-command-dot" aria-hidden="true"><\/span>RAN<\/summary>/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /\/bin\/bash|<script>|<summary>Command/);
    assert.equal(systemEngineerEventText(entry), command);
  }
});

// Keeps live and restored command blocks separated and bounded to seven wrapped lines,
// with scroll access to the full command and a left border for transcript readability.
test("SE command styles separate blocks and limit the bordered command viewport to seven lines", async () => {
  const styles = await readFile("ui/nextjs/app/styles/home-conversation.css", "utf8");
  const command = styles.match(/\.system-engineer-command \{([^}]+)\}/)[1];
  const value = styles.match(/\.system-engineer-event-value \{([^}]+)\}/)[1];
  const content = styles.match(/\.system-engineer-command \.system-engineer-event-value \{([^}]+)\}/)[1];
  assert.match(command, /margin-block: 12px;/);
  assert.match(command, /padding: 0 12px;/);
  assert.match(command, /min-width: 0;/);
  assert.match(value, /overflow: auto;/);
  assert.match(value, /border-left: 1px solid var\(--app-border\);/);
  assert.match(value, /white-space: pre-wrap;/);
  assert.match(value, /overflow-wrap: anywhere;/);
  const maxHeight = Number(value.match(/max-height: ([\d.]+)em;/)[1]);
  const lineHeight = Number(content.match(/font: 12px\/([\d.]+)/)[1]);
  assert.ok(Math.abs(maxHeight / lineHeight - 7) < 0.000001);
  assert.match(content, /font-size: 12px !important;/);
});

// Lifecycle traffic stays in storage without adding technical or empty chat entries.
test("SE presentation hides output and lifecycle envelopes", async () => {
  const { systemEngineerEventText } = await loadModule("ui/nextjs/components/system-engineer-event.jsx");
  const command = "git status --short; sed -n '1,75p' ui/nextjs/components/system-engineer-event.jsx";
  const output = "line\n".repeat(5000);
  assert.equal(systemEngineerEventText({ type: "item.started", item: { type: "command_execution", command } }), command);
  assert.equal(systemEngineerEventText({ type: "item.completed", item: { type: "command_execution", command, aggregated_output: output, exit_code: 1 } }), command);
  assert.equal(systemEngineerEventText({ type: "thread.started", thread_id: "THREAD" }), "");
  assert.equal(systemEngineerEventText({ type: "turn.completed", usage: { input_tokens: 100 } }), "");
  assert.equal(systemEngineerEventText({ type: "turn.failed", error: { message: "Check failed" } }), "");
});

// Both providers use the same plain conversation presentation for public text and tools.
test("SE renderer hides raw Claude provider blocks", async () => {
  const { systemEngineerEventText } = await loadModule("ui/nextjs/components/system-engineer-event.jsx");
  assert.equal(systemEngineerEventText({ type: "assistant", message: { content: [{ type: "text", text: "Checking files" }, { type: "tool_use", name: "Bash", input: { command: "git status --short" } }] } }), "");
  assert.equal(systemEngineerEventText({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "line one\nline two" }] }] } }), "");
});

// Exercises live snapshots, legacy deltas and completion through the actual hook, not a render-only grouping helper.
test("realtime text-command-text remains one assistant message and rejects stale replay", async () => {
  let listener;
  let messages = [];
  const { useProjectEventStream } = await loadModule("ui/nextjs/lib/home-page-event-stream.js", { useRef: (value) => ({ current: value }), useEffect: (effect) => { effect(); } });
  useProjectEventStream({ client: { connectProjectStream: (options) => { listener = options.onEvent; return { close() {} }; } }, projectId: "PROJECT",
    activeConversationIdRef: { current: "CHAT" }, agentDirectoryRef: { current: [] }, agentDisplayName: () => "Real agent",
    setMessages: (update) => { messages = update(messages); }, setAgentActivities() {}, setAgentTyping() {} });
  const first = event("FIRST");
  first.payload.sdk_sequence = 1;
  first.payload.sdk_event = { type: "conversation_turn", entries: [{ id: "TEXT-1", type: "text", text: "Checking" }] };
  listener(first);
  const second = event("SECOND");
  second.payload.sdk_sequence = 2;
  second.payload.sdk_event = { type: "conversation_turn", entries: [...first.payload.sdk_event.entries,
    { id: "COMMAND", type: "command_execution", command: "git diff" }, { id: "TEXT-2", type: "text", text: "Done" }] };
  listener(second);
  listener({ project_id: "PROJECT", event_type: "conversation.message.delta", payload: { conversation_id: "CHAT", correlation_id: "RUN", chunk: "CheckingDone", agent_id: "SE" } });
  listener({ project_id: "PROJECT", event_type: "conversation.message.received", payload: { conversation_id: "CHAT", correlation_id: "RUN", text: "CheckingDone", agent_id: "SE" } });
  listener(first);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].correlation_id, "RUN");
  assert.equal(messages[0].se_event.entries.length, 3);
  const { SystemEngineerReply } = await loadModule("ui/nextjs/components/system-engineer-reply.jsx");
  const html = renderToStaticMarkup(createElement(SystemEngineerReply, { message: messages[0], displayMessageTime: () => "12:30" }));
  assert.equal((html.match(/class="claude-message is-agent"/g) ?? []).length, 1);
  assert.equal((html.match(/class="claude-message-meta"/g) ?? []).length, 1);
  assert.match(html, /Real agent/);
  assert.match(html, /12:30/);
  assert.match(html, /<details class="system-engineer-command" open="">/);
  assert.match(html, /<summary><span class="system-engineer-command-dot" aria-hidden="true"><\/span>RAN<\/summary>/);
  assert.ok(html.indexOf("Checking") < html.indexOf("git diff"));
  assert.ok(html.indexOf("git diff") < html.indexOf("Done"));
});
