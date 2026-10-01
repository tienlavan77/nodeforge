import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const controlApiEntry = fileURLToPath(new URL("../../scripts/start-control-api.mjs", import.meta.url));

test("Owner request reaches the real Agent and persisted stream is replayable", { timeout: 120000 }, async (t) => {
  if (!process.env.OPENAI_BASE_URL || !process.env.OPENAI_API_KEY) return t.skip("Real gateway credential is not configured.");
  await mkdir(join(process.cwd(), ".forge/runtime"), { recursive: true });
  const dataDir = await mkdtemp(join(process.cwd(), ".forge/runtime/nf150-"));
  const port = 31250 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [controlApiEntry], { cwd: process.cwd(), env: { ...process.env, NODE_CONTROL_PORT: String(port), NODE_CONTROL_DATA_DIR: dataDir, NODE_SECRET_ENCRYPTION_KEY: "nf150-test-encryption-key", NODE_AGENT_TIMEOUT_MS: "60000" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { child.kill("SIGTERM"); await rm(dataDir, { recursive: true, force: true }); });
  await waitForOutput(child.stdout, "Node Control API listening", 20000);
  const base = `http://127.0.0.1:${port}`;
  const correlation = "CORR-NF150";
  const agentId = "a1111111-1111-4111-8111-111111111111";
  const agent = await fetch(`${base}/forge/v1/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent_id: agentId, agent_name: "Disposable Architecture Agent", role: "architecture_manager", provider: "codex", model: process.env.NODE_AGENT_MODEL ?? "gpt-6-sol", gateway_url: process.env.OPENAI_BASE_URL, api_key: process.env.OPENAI_API_KEY, enabled: true, status: "ready" }) });
  assert.equal(agent.status, 201, JSON.stringify(await agent.json()));
  const conversation = await fetch(`${base}/forge/v1/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: "PROJECT-NF150", agent_id: agentId, title: "Provider chat witness" }) });
  const conversationBody = await conversation.json();
  assert.equal(conversation.status, 201, JSON.stringify(conversationBody));
  const conversationId = conversationBody.id;
  const sent = await fetch(`${base}/forge/v1/conversations/${conversationId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: "PROJECT-NF150", message_id: "MSG-NF150", correlation_id: correlation, timestamp: new Date().toISOString(), payload: { text: "Reply with exactly three words: system ready status." } }) });
  assert.equal(sent.status, 202);
  let history;
  for (let attempt = 0; attempt < 70; attempt += 1) {
    history = await fetch(`${base}/forge/v1/projects/PROJECT-NF150/history?conversationId=${conversationId}&correlationId=${correlation}&limit=100`).then((response) => response.json());
    if (history.items.some((item) => item.type === `${agentId}.message.received` || item.type === `${agentId}.error`)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert(history.items.some((item) => item.type === `${agentId}.message.received` && item.content.text === "system ready status"), JSON.stringify(history));
  const deltas = history.items.filter((item) => item.type === `${agentId}.message.delta`);
  assert.equal(deltas.length, 0);
  assert(history.items.every((item) => item.correlation_id === correlation));
  assert.equal(JSON.stringify(history).includes(process.env.OPENAI_API_KEY), false);
  const replay = await fetch(`${base}/projects/PROJECT-NF150/conversations/${conversationId}/stream?after=${encodeURIComponent("MSG-NF150")}`);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("content-type"), "text/event-stream; charset=utf-8");
  await replay.body?.cancel();
});

function waitForOutput(stream, text, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${text}`)), timeoutMs);
    stream.on("data", (chunk) => { output += chunk; if (output.includes(text)) { clearTimeout(timer); resolve(); } });
    stream.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
