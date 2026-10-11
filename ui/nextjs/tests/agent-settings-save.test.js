// Verifies agent Save reports stale APIs, canonical failures and timeouts instead of hanging or claiming success.
import assert from "node:assert/strict";
import test from "node:test";
import { saveAgentSettingsForm } from "../lib/agent-settings-save.js";

test("agent save confirms requested profile and tool mode", async (context) => {
  const previous = globalThis.fetch;
  context.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/agents/A");
    assert.equal(init.method, "PUT");
    return new Response(JSON.stringify({ agent_id: "A", tool_mode: "builtin" }));
  };
  assert.equal((await saveAgentSettingsForm({ url: "/agents", agentId: "A", settings: { tool_mode: "builtin" } })).tool_mode, "builtin");
});

test("agent save rejects stale API acknowledgements and displays canonical error messages", async (context) => {
  const previous = globalThis.fetch;
  context.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => new Response(JSON.stringify({ agent_id: "A" }));
  await assert.rejects(saveAgentSettingsForm({ url: "/agents", agentId: "A", settings: { tool_mode: "forge" } }), /Restart API/);
  globalThis.fetch = async () => new Response(JSON.stringify({ code: "CONFIGURATION_ERROR", message: "Invalid tool mode", scope: "field", retryable: false, requestId: "R" }), { status: 422 });
  await assert.rejects(saveAgentSettingsForm({ url: "/agents", settings: {} }), /Invalid tool mode/);
});

test("agent save aborts pending requests and clears the save wait", async (context) => {
  const previous = globalThis.fetch;
  context.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  await assert.rejects(saveAgentSettingsForm({ url: "/agents", settings: {}, fetchTimeoutMs: 10 }), /quá thời gian chờ/);
});
