// Verify accessible conversation actions preserve callbacks and fail safely against existing APIs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createConversationCrudService } from "../../../backend/src/application/conversation-crud-service.js";
import { createForgeV1ConversationRoutes } from "../../../backend/src/transport/http/forge-v1-conversation-routes.js";

const source = await readFile("ui/nextjs/components/ConversationsBlock.jsx", "utf8");
const styles = await readFile("ui/nextjs/app/styles/conversations.css", "utf8");
const executable = source.slice(0, source.indexOf("  return (\n    <li"))
  .replace(/import .* from "react";/, "")
  .replace("export function", "function") + "return { handleDelete, handleRenameConfirm, handleArchive, handleTogglePin }; }\nConversationsBlock(props);";

// Exercise real component handlers with isolated hooks, confirmation, network, and callback witnesses.
function mountActions({ confirmed = true, responses = [], props = {} } = {}) {
  const requests = [];
  const events = [];
  const errors = [];
  const refs = [];
  let confirmations = 0;
  let stateIndex = 0;
  const handlers = runInNewContext(executable, {
    props: {
      conversation: { id: "conversation/id", title: "Example", pinned: false },
      editTitle: "Renamed",
      onDeleted: () => events.push("delete"),
      onConfirmRename: () => events.push("rename"),
      onArchived: () => events.push("archive"),
      onTogglePin: (updated) => events.push(updated.pinned ? "pin" : "unpin"),
      onPinError: (message) => errors.push(message),
      ...props,
    },
    useRef: (value) => { const ref = { current: value }; refs.push(ref); return ref; },
    useState: (value) => { const index = stateIndex++; return [value, (next) => { if (index === 0 && next) errors.push(next); }]; },
    window: { confirm: () => { confirmations++; return confirmed; } },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, "unexpected API request");
      return response;
    },
  });
  return { handlers, requests, events, errors, refs, confirmations: () => confirmations };
}

// Supply HTTP responses without masking malformed JSON or network failures.
function response(status = 200, payload = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

// Confirm destructive actions before sending any request and preserve the existing DELETE contract.
test("delete cancellation sends no request; confirmation sends one DELETE before success", async () => {
  const cancelled = mountActions({ confirmed: false });
  await cancelled.handlers.handleDelete();
  assert.equal(cancelled.confirmations(), 1);
  assert.equal(cancelled.requests.length, 0);
  assert.deepEqual(cancelled.events, []);
  const confirmed = mountActions({ responses: [response(200, { id: "conversation/id" })] });
  await confirmed.handlers.handleDelete();
  assert.equal(confirmed.requests[0].method, "DELETE");
  assert.equal(confirmed.requests[0].url, "/forge/v1/conversations/conversation%2Fid");
  assert.deepEqual(confirmed.events, ["delete"]);
});

// Ensure every mutation rejects HTTP, network, and malformed-response failures without success callbacks.
test("failed actions expose errors and never report success", async () => {
  for (const action of ["handleDelete", "handleRenameConfirm", "handleArchive", "handleTogglePin"]) {
    for (const failure of [response(403, { message: "Permission denied" }), new Error("Offline"), { ok: true, json: async () => { throw new Error("Invalid JSON"); } }]) {
      const mounted = mountActions({ responses: [failure] });
      await mounted.handlers[action]();
      assert.deepEqual(mounted.events, [], action);
      assert.ok(mounted.errors.length > 0, action);
      assert.equal(mounted.requests.length, 1, action);
    }
  }
  assert.match(source, /role="alert"/);
});

// Preserve pin/unpin and title PATCH callbacks only after their existing APIs succeed.
test("successful pin, unpin, and rename preserve request and callback semantics", async () => {
  const pin = mountActions({ responses: [response(200, { pinned: true })] });
  await pin.handlers.handleTogglePin();
  assert.match(pin.requests[0].url, /\/pin$/);
  assert.deepEqual(pin.events, ["pin"]);
  const unpin = mountActions({ responses: [response(200, { pinned: false })], props: { conversation: { id: "id", pinned: true } } });
  await unpin.handlers.handleTogglePin();
  assert.match(unpin.requests[0].url, /\/unpin$/);
  assert.deepEqual(unpin.events, ["unpin"]);
  const rename = mountActions({ responses: [response()] });
  await rename.handlers.handleRenameConfirm();
  assert.equal(rename.requests[0].method, "PATCH");
  assert.deepEqual(JSON.parse(rename.requests[0].body), { title: "Renamed" });
  assert.deepEqual(rename.events, ["rename"]);
});

// Retry Archive via the established status PATCH only when the endpoint is unsupported.
test("Archive fallback persists archived status and does not bypass server failures", async () => {
  const direct = mountActions({ responses: [response(200, { status: "archived" })] });
  await direct.handlers.handleArchive();
  assert.equal(direct.requests.length, 1);
  assert.deepEqual(direct.events, ["archive"]);
  for (const status of [404, 405, 501]) {
    const mounted = mountActions({ responses: [response(status), response(200, { status: "archived" })] });
    await mounted.handlers.handleArchive();
    assert.equal(mounted.requests[1].method, "PATCH");
    assert.deepEqual(JSON.parse(mounted.requests[1].body), { archived: true, status: "archived" });
    assert.deepEqual(mounted.events, ["archive"]);
  }
  for (const failure of [response(500, { message: "Archive unavailable" }), response(200, { status: "active" })]) {
    const mounted = mountActions({ responses: [failure] });
    await mounted.handlers.handleArchive();
    assert.equal(mounted.requests.length, 1);
    assert.deepEqual(mounted.events, []);
    assert.ok(mounted.errors.length);
  }
  const failedFallback = mountActions({ responses: [response(405), response(500, { message: "Patch failed" })] });
  await failedFallback.handlers.handleArchive();
  assert.deepEqual(failedFallback.events, []);
  assert.deepEqual(failedFallback.errors, ["Patch failed"]);
});

// Witness the existing backend Archive and PATCH contract without adding routes or fields.
test("existing backend Archive and fallback PATCH both return persisted archived status", async () => {
  const row = { id: "id", project_id: "project", agent_id: "agent", title: "Example", status: "active", pinned: 0 };
  const database = { all: () => [row], run: () => {} };
  const service = createConversationCrudService({ database });
  const routes = createForgeV1ConversationRoutes({ conversationCrudService: service });
  for (const [method, parts] of [["POST", ["conversations", "id", "archive"]], ["PATCH", ["conversations", "id"]]]) {
    const result = await routes.routeConversation({ method, parts, body: { archived: true, status: "archived" }, projectId: "project" });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, "archived");
    assert.equal(Object.hasOwn(result.body, "archived"), false);
  }
});

// Guard duplicate keyboard submissions and Escape-triggered blur against unintended rename requests.
test("pending actions and cancelled rename do not issue duplicate mutations", async () => {
  const mounted = mountActions({ responses: [response()] });
  await Promise.all([mounted.handlers.handleRenameConfirm(), mounted.handlers.handleRenameConfirm()]);
  assert.equal(mounted.requests.length, 1);
  assert.deepEqual(mounted.events, ["rename"]);
  const cancelled = mountActions();
  cancelled.refs[2].current = true;
  await cancelled.handlers.handleRenameConfirm();
  assert.equal(cancelled.requests.length, 0);
});

// Verify native keyboard controls, isolated bubbling, accessible icon names, and touch/focus visibility wiring.
test("icons are named and actions remain reachable without selecting their conversation", () => {
  const actions = source.slice(source.indexOf('<div className="conversations-block-actions"'));
  assert.equal((actions.match(/<button type="button"/g) ?? []).length, 4);
  assert.equal((actions.match(/title=/g) ?? []).length, 4);
  assert.equal((actions.match(/aria-label=/g) ?? []).length, 4);
  assert.equal((actions.match(/<svg aria-hidden="true"/g) ?? []).length, 4);
  for (const event of ["onClick", "onKeyDown", "onKeyUp"]) assert.ok(actions.includes(`${event}={(event) => event.stopPropagation()}`));
  assert.doesNotMatch(actions, /onSelect|preventDefault/);
  for (const selector of [":hover", ":focus-within", ".is-active", ".is-selected"]) assert.ok(styles.includes(`.conversations-block${selector} .conversations-block-actions`));
  assert.match(source, /checked \? " is-selected"/);
  assert.match(styles, /@media \(hover: none\), \(pointer: coarse\)/);
  assert.match(styles, /width: 44px; height: 44px/);
  assert.match(styles, /conversations-block-action:focus-visible/);
});
