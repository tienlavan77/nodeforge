import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { reconcileConversationHistory } from "../lib/conversation-history-reconciliation.js";
import { appendSystemEngineerConversationEvent } from "../lib/system-engineer-conversation-events.js";

const requireFromUi = createRequire(new URL("../package.json", import.meta.url));
const requireFromBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
const { build } = requireFromBackend("esbuild");

// Business purpose: loads a Next.js JSX component module in Node test runtime so tests can execute the real component code rather than string matching.
// Technical description: bundles the target file with esbuild in CommonJS automatic JSX mode and intercepts react/jsx-runtime so component calls return inspectable element trees.
async function loadCompiledModule(entryPath, customReact) {
  const compiled = await build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["react", "react/*"]
  });
  const mod = { exports: {} };
  const jsxRuntime = {
    Fragment: Symbol.for("react.fragment"),
    jsx: (type, props, key) => ({ type, props: props ?? {}, key: key ?? null }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key: key ?? null })
  };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(
    (name) => {
      if (name === "react" && customReact) return customReact;
      if (name === "react/jsx-runtime" || name === "react/jsx-dev-runtime") return jsxRuntime;
      return requireFromUi(name);
    },
    mod,
    mod.exports
  );
  return mod.exports;
}

// Business purpose: mounts a functional React component with stateful hooks and effect dependency tracking for deterministic UI unit tests.
// Technical description: maintains indexed useState and useEffect slots across re-renders and provides recursive VNode tree query helpers.
function createComponentHarness(Component, initialProps) {
  const states = [];
  const effects = [];
  const refs = [];
  let stateCursor = 0;
  let effectCursor = 0;
  let refCursor = 0;
  let rendering = false;
  let currentProps = initialProps;
  let tree = null;

  const reactMock = {
    useState(initialValue) {
      const idx = stateCursor++;
      if (!(idx in states)) {
        states[idx] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      const setState = (next) => {
        states[idx] = typeof next === "function" ? next(states[idx]) : next;
        if (!rendering) render(currentProps);
      };
      return [states[idx], setState];
    },
    useEffect(fn, deps) {
      const idx = effectCursor++;
      const prevDeps = effects[idx]?.deps;
      const changed = !prevDeps || !deps || deps.some((d, i) => !Object.is(d, prevDeps[i]));
      if (changed) {
        effects[idx] = { deps, fn, pending: true };
      }
    },
    useRef(initialValue) {
      const idx = refCursor++;
      if (!(idx in refs)) refs[idx] = { current: initialValue };
      return refs[idx];
    }
  };

  // Business purpose: recursively evaluates functional child components so composite branches render full DOM element trees.
  // Technical description: traverses VNode arrays and children props, invoking function-typed VNodes with their props in deterministic tree order.
  function expandNode(node) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expandNode);
    if (typeof node.type === "function") return expandNode(node.type(node.props ?? {}));
    if (node.props?.children) {
      return { ...node, props: { ...node.props, children: expandNode(node.props.children) } };
    }
    return node;
  }

  // Business purpose: renders the component under test with updated props while preserving hook state.
  // Technical description: resets hook cursors, executes the component and nested child components, and flushes pending useEffect callbacks.
  function render(nextProps = currentProps) {
    currentProps = nextProps;
    for (let pass = 0; pass < 4; pass++) {
      rendering = true;
      stateCursor = 0;
      effectCursor = 0;
      refCursor = 0;
      tree = expandNode(Component(currentProps));
      rendering = false;
      const pendingEffects = effects.filter((entry) => entry?.pending);
      if (pendingEffects.length === 0) break;
      for (const entry of pendingEffects) {
        entry.pending = false;
        entry.fn();
      }
    }
    return tree;
  }

  // Business purpose: locates rendered virtual DOM elements matching a test predicate.
  // Technical description: recursively traverses element children arrays and props.children objects to collect matching nodes.
  function findNodes(node, predicate, acc = []) {
    if (!node || typeof node !== "object") return acc;
    if (Array.isArray(node)) {
      for (const item of node) findNodes(item, predicate, acc);
      return acc;
    }
    if (predicate(node)) acc.push(node);
    if (node.props?.children) findNodes(node.props.children, predicate, acc);
    return acc;
  }

  return {
    reactMock,
    render,
    setProps: (nextProps) => { currentProps = nextProps; },
    getProps: () => currentProps,
    getTree: () => tree,
    findNodes: (predicate) => findNodes(tree, predicate)
  };
}

test("conversation message actions expose owner copy, edit, and retry controls without agent-only controls", async () => {
  const actionsSource = await readFile(new URL("../components/conversation-message-actions.jsx", import.meta.url), "utf8");
  const architectureChatSource = await readFile(new URL("../components/architecture-workspace.jsx", import.meta.url), "utf8");
  const systemChatSource = await readFile(new URL("../app/system/page.jsx", import.meta.url), "utf8");
  const handlersSource = await readFile(new URL("../lib/home-page-message-handlers.js", import.meta.url), "utf8");
  const stylesSource = await readFile(new URL("../app/styles/message-actions.css", import.meta.url), "utf8");
  const homeConversationStyles = await readFile(new URL("../app/styles/home-conversation.css", import.meta.url), "utf8");

  assert.match(actionsSource, /export function ConversationMessageActions/);
  assert.match(actionsSource, /export function ConversationAgentMessageActions/);
  assert.match(actionsSource, /aria-label=\{copied \? "Copied message" : "Copy message"\}/);
  assert.match(actionsSource, /aria-label=\{copied \? "Copied agent message" : "Copy agent message"\}/);
  assert.match(actionsSource, /aria-label="Share agent message"/);
  assert.match(actionsSource, /aria-label=\{isIdea \? "Remove idea mark" : "Mark as idea"\}/);
  assert.match(actionsSource, /aria-pressed=\{isIdea\}/);
  assert.match(actionsSource, /className="conversation-idea-badge">Idea<\/span>/);
  assert.match(actionsSource, /aria-label="Edit message"/);
  assert.match(actionsSource, /aria-label="Retry message"/);
  assert.match(architectureChatSource, /<ConversationMessageActions message=\{message\}/);
  assert.match(architectureChatSource, /<ConversationAgentMessageActions message=\{message\}/);
  assert.match(systemChatSource, /<ConversationMessageActions message=\{message\}/);
  assert.match(systemChatSource, /<ConversationAgentMessageActions message=\{message\}/);
  assert.match(systemChatSource, /message\.timeline \? <SystemEngineerTimelineEntries timeline=\{message\.timeline\}/);
  assert.doesNotMatch(systemChatSource, /export\s*\{/);
  assert.match(handlersSource, /function editMessage/);
  assert.match(handlersSource, /function retryMessage/);
  assert.match(stylesSource, /\.claude-message\.is-owner \.claude-message-actions/);
  assert.match(stylesSource, /\.claude-message\.is-agent \.claude-message-actions/);
  assert.match(stylesSource, /\.claude-message-actions button\.is-idea-active/);
  assert.match(homeConversationStyles, /\.conversation-idea-badge\s*\{[^}]*margin-left:\s*auto/);
});

test("ConversationAgentMessageActions component marks and unmarks an Idea, updates badge and parent callback, and rolls back on API failure", async () => {
  let harness;
  const reactProxy = {
    useState: (...args) => harness.reactMock.useState(...args),
    useEffect: (...args) => harness.reactMock.useEffect(...args)
  };
  const { ConversationAgentMessageActions } = await loadCompiledModule(
    fileURLToPath(new URL("../components/conversation-message-actions.jsx", import.meta.url)),
    reactProxy
  );

  const apiCalls = [];
  const parentUpdates = [];
  let shouldFail = false;

  const mockClient = {
    setConversationMessageIdea: async (payload) => {
      apiCalls.push(payload);
      if (shouldFail) throw new Error("Simulated persistence failure");
      return { message_id: payload.messageId, is_idea: payload.isIdea };
    }
  };

  let messageState = {
    id: "ACT-99",
    source_message_id: "MSG-PERSISTED-99",
    conversation_id: "CONV-1",
    from: "agent",
    text: "Proposed architecture refinement",
    is_idea: false
  };

  harness = createComponentHarness(ConversationAgentMessageActions, {
    message: messageState,
    client: mockClient,
    projectId: "PROJECT-1",
    onToggleIdea: (target, nextIdea) => {
      messageState = { ...messageState, is_idea: nextIdea };
      parentUpdates.push({ id: target.id, source_message_id: target.source_message_id, is_idea: nextIdea });
      harness.setProps({ ...harness.getProps(), message: messageState });
    },
    children: { type: "p", props: { children: "Proposed architecture refinement" } }
  });

  harness.render();

  const getIdeaBadge = () => harness.findNodes((n) => n.type === "span" && n.props?.className === "conversation-idea-badge")[0] ?? null;
  const getIdeaButton = () => harness.findNodes((n) => n.type === "button" && (n.props?.["aria-label"] === "Mark as idea" || n.props?.["aria-label"] === "Remove idea mark"))[0] ?? null;
  const getStatusNode = () => harness.findNodes((n) => n.type === "p" && n.props?.className === "conversation-markdown-export-status")[0] ?? null;

  assert.equal(getIdeaBadge(), null);
  assert.equal(getIdeaButton().props["aria-pressed"], false);
  assert.equal(getIdeaButton().props["aria-label"], "Mark as idea");

  // 1. Mark as idea
  getIdeaButton().props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(getIdeaBadge(), "Idea badge should render when marked");
  assert.equal(getIdeaBadge().props.children, "Idea");
  const actionsBar = harness.findNodes((n) => n.type === "div" && n.props?.className === "claude-message-actions")[0];
  assert.ok(actionsBar, "Agent message actions bar should exist");
  const badgeInsideActions = Array.isArray(actionsBar.props?.children) && actionsBar.props.children.some((child) => child?.type === "span" && child?.props?.className === "conversation-idea-badge");
  assert.ok(badgeInsideActions, "Idea badge should render inside claude-message-actions");
  assert.equal(getIdeaButton().props["aria-pressed"], true);
  assert.equal(getIdeaButton().props["aria-label"], "Remove idea mark");
  assert.equal(apiCalls.length, 1);
  assert.deepEqual(apiCalls[0], {
    projectId: "PROJECT-1",
    conversationId: "CONV-1",
    messageId: "MSG-PERSISTED-99",
    isIdea: true
  });
  assert.equal(messageState.is_idea, true);
  assert.equal(parentUpdates.at(-1).is_idea, true);

  // 2. Unmark idea
  getIdeaButton().props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(getIdeaBadge(), null, "Idea badge should disappear when unmarked");
  assert.equal(getIdeaButton().props["aria-pressed"], false);
  assert.equal(apiCalls.length, 2);
  assert.equal(apiCalls[1].isIdea, false);
  assert.equal(messageState.is_idea, false);

  // 3. API failure rolls back optimistic update and surfaces error status
  shouldFail = true;
  getIdeaButton().props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(getIdeaBadge(), null, "Idea badge must roll back to hidden after API failure");
  assert.equal(getIdeaButton().props["aria-pressed"], false);
  assert.equal(messageState.is_idea, false);
  assert.deepEqual(parentUpdates.slice(-2).map((u) => u.is_idea), [true, false]);
  assert.ok(getStatusNode(), "Error status must be rendered on failure");
  assert.equal(getStatusNode().props.children, "Simulated persistence failure");

  // 4. Stream update, history reload, and conversation switch synchronize component state via props
  shouldFail = false;
  getIdeaButton().props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.render({
    message: messageState,
    client: mockClient,
    projectId: "PROJECT-1",
    onToggleIdea: (target, nextIdea) => {
      messageState = { ...messageState, is_idea: nextIdea };
      parentUpdates.push({ id: target.id, source_message_id: target.source_message_id, is_idea: nextIdea });
    },
    children: { type: "p", props: { children: "Proposed architecture refinement" } }
  });
  assert.ok(getIdeaBadge());

  // Simulate newer SE stream snapshot without explicit is_idea flag preserving marked state
  const streamUpdated = appendSystemEngineerConversationEvent(
    [{
      ...messageState,
      stream_key: "agent:RUN-99",
      correlation_id: "RUN-99",
      sdk_sequence: 1,
      se_event: { type: "conversation_turn", entries: [{ id: "E-1", type: "text", text: "Proposed architecture refinement" }] },
      has_explicit_idea: true
    }],
    {
      event_id: "MSG-PERSISTED-99-V2",
      event_type: "agent.activity",
      timestamp: "2026-11-02T00:00:05Z",
      payload: {
        activity_id: "ACT-99-V2",
        agent_role: "system_engineer",
        conversation_id: "CONV-1",
        correlation_id: "RUN-99",
        sdk_sequence: 2,
        sdk_event: { type: "conversation_turn", entries: [{ id: "E-1", type: "text", text: "Streamed refinement v2" }] }
      }
    },
    "CONV-1",
    "SE"
  );
  harness.render({
    message: streamUpdated[0],
    client: mockClient,
    projectId: "PROJECT-1",
    onToggleIdea: (target, nextIdea) => { messageState = { ...target, is_idea: nextIdea }; },
    children: { type: "p", props: { children: streamUpdated[0].text } }
  });
  assert.ok(getIdeaBadge(), "Idea badge stays visible across stream snapshot without explicit is_idea");

  // Simulate reload reconciliation with persisted history
  const reloadedHistory = reconcileConversationHistory(streamUpdated, [{
    id: "ACT-99-V2",
    source_message_id: "MSG-PERSISTED-99",
    conversation_id: "CONV-1",
    correlation_id: "RUN-99",
    stream_key: "agent:RUN-99",
    from: "agent",
    text: "Streamed refinement v2",
    is_idea: true,
    has_explicit_idea: true,
    timestamp: "2026-11-02T00:00:05Z"
  }]);
  harness.render({
    message: reloadedHistory[0],
    client: mockClient,
    projectId: "PROJECT-1",
    onToggleIdea: (target, nextIdea) => { messageState = { ...target, is_idea: nextIdea }; },
    children: { type: "p", props: { children: reloadedHistory[0].text } }
  });
  assert.ok(getIdeaBadge(), "Idea badge stays visible after history reload");

  // Simulate switching to another conversation message that is not marked as an idea
  const otherConversationMessage = {
    id: "MSG-CONV-2",
    source_message_id: "MSG-CONV-2",
    conversation_id: "CONV-2",
    from: "agent",
    text: "Unmarked reply in second conversation",
    is_idea: false
  };
  harness.render({
    message: otherConversationMessage,
    client: mockClient,
    projectId: "PROJECT-1",
    onToggleIdea: (target, nextIdea) => { messageState = { ...target, is_idea: nextIdea }; },
    children: { type: "p", props: { children: otherConversationMessage.text } }
  });
  assert.equal(getIdeaBadge(), null, "Switching conversation message clears local Idea badge when new message is unmarked");
  assert.equal(getIdeaButton().props["aria-pressed"], false);
});

test("System page timeline presentation renders SystemEngineerTimelineEntries and toggles Idea using original message IDs", async () => {
  let harness;
  const reactProxy = {
    useState: (...args) => harness.reactMock.useState(...args),
    useEffect: (...args) => harness.reactMock.useEffect(...args),
    useRef: (...args) => harness.reactMock.useRef(...args)
  };
  const {
    SystemEngineerTimelineEntries,
    groupAgentTurnMessages,
    transcriptAgentName
  } = await loadCompiledModule(
    fileURLToPath(new URL("../components/system-engineer-reply.jsx", import.meta.url)),
    reactProxy
  );

  // Verify correlated non-conversation_turn agent replies (legacy history + fallback replies) in timeline entries
  const rawMessages = [
    { id: "LEGACY-MSG-1", source_message_id: "PERSISTED-LEGACY-1", conversation_id: "CONV-SYS", correlation_id: "TURN-LEGACY", nickname: "System Engineer · command", from: "agent", text: "Legacy agent reply in correlated turn", is_idea: true, timestamp: "2026-11-02T00:00:01Z" },
    { id: "FALLBACK-MSG-2", source_message_id: "PERSISTED-FALLBACK-2", conversation_id: "CONV-SYS", correlation_id: "TURN-LEGACY", from: "agent", text: "Fallback correlated reply", is_idea: false, timestamp: "2026-11-02T00:00:02Z" }
  ];

  const groupedList = groupAgentTurnMessages(rawMessages);
  assert.equal(groupedList.length, 1);
  const groupedCard = groupedList[0];

  assert.equal(groupedCard.id, "agent-turn:TURN-LEGACY");
  assert.equal(transcriptAgentName(groupedCard), "System Engineer");
  assert.equal(groupedCard.timeline.length, 2);
  assert.equal(groupedCard.timeline[0].source_message_id, "PERSISTED-LEGACY-1");
  assert.equal(groupedCard.timeline[1].source_message_id, "PERSISTED-FALLBACK-2");

  const apiCalls = [];
  const mockClient = {
    setConversationMessageIdea: async (payload) => {
      apiCalls.push(payload);
      return { message_id: payload.messageId, is_idea: payload.isIdea };
    }
  };

  // Mount the actual SystemEngineerTimelineEntries branch used by System page
  let timelineEntries = [...groupedCard.timeline];
  harness = createComponentHarness(SystemEngineerTimelineEntries, {
    timeline: timelineEntries,
    client: mockClient,
    projectId: "PROJECT-SYS",
    onToggleIdea: (target, nextIdea) => {
      timelineEntries = timelineEntries.map((item) =>
        (item.id === target.id || (target.source_message_id && item.source_message_id === target.source_message_id))
          ? { ...item, is_idea: nextIdea, has_explicit_idea: true }
          : item
      );
      harness.setProps({ ...harness.getProps(), timeline: timelineEntries });
    },
    onMarkdownOpen: () => {},
    onReveal: () => {}
  });

  harness.render();
  const getIdeaBadges = () => harness.findNodes((n) => n.type === "span" && n.props?.className === "conversation-idea-badge");
  const getIdeaButtons = () => harness.findNodes((n) => n.type === "button" && (n.props?.["aria-label"] === "Mark as idea" || n.props?.["aria-label"] === "Remove idea mark"));

  // Entry 0 starts marked as Idea, Entry 1 starts unmarked
  assert.equal(getIdeaBadges().length, 1);
  assert.equal(getIdeaButtons().length, 2);
  assert.equal(getIdeaButtons()[0].props["aria-pressed"], true);
  assert.equal(getIdeaButtons()[1].props["aria-pressed"], false);

  // Click Idea toggle on Entry 1 (fallback reply) inside the rendered timeline branch
  getIdeaButtons()[1].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Ensure API receives the real message ID (PERSISTED-FALLBACK-2), NOT the synthetic group id "agent-turn:TURN-LEGACY"
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].messageId, "PERSISTED-FALLBACK-2");
  assert.equal(apiCalls[0].isIdea, true);
  assert.equal(timelineEntries[1].is_idea, true);
  assert.equal(timelineEntries[0].is_idea, true);
  assert.equal(getIdeaBadges().length, 2);
  assert.equal(getIdeaButtons()[1].props["aria-pressed"], true);
});
