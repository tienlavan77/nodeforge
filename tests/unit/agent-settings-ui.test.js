import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ui = readFileSync(new URL("../../web/src/main.jsx", import.meta.url), "utf8");
const client = readFileSync(new URL("../../web/src/services/node-client.js", import.meta.url), "utf8");

test("Agent Settings UI presents a masked, Node-only settings flow for every panel", () => {
  assert.match(ui, /function AgentSettingsOverlay/);
  assert.match(ui, /type="password"/);
  assert.match(ui, /placeholder="\*{8}"/);
  assert.match(ui, /Save Profile/);
  assert.match(ui, /Test Connection/);
  assert.match(ui, /setKey\(""\)/);
  assert.match(ui, /Connected: \$\{result\.status\}/);
  assert.match(ui, /Failed: \$\{error\.message\}/);
  assert.match(ui, /function mergeStreamMessage/);
  assert.match(ui, /correlation_id === message\.correlation_id/);
  assert.match(ui, /current\.text\}\$\{message\.payload\?\.text/);
  assert.match(ui, /natural-conversation/);
  assert.match(ui, /Architecture Manager is working…/);
  assert.match(ui, /<textarea/);
  assert.match(ui, /event\.key === "Enter" && !event\.shiftKey/);
  assert.doesNotMatch(ui, /<HumanDecisionActions client=\{client\} onWorkspaceChanged=\{onWorkspaceChanged\}/);
  assert.match(ui, /natural-message/);
  assert.match(ui, /AGENTS\.slice\(2\).*onSettings=/s);
  assert.match(client, /fetch\("\/agents\/settings"\)/);
  assert.match(client, /fetch\(`\/agents\/\$\{agentId\}\/settings`/);
  assert.match(client, /fetch\(`\/agents\/\$\{agentId\}\/settings\/test`/);
  assert.doesNotMatch(ui, /gateway_url.*fetch|fetch.*gateway_url/);
});
