import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Owner request reaches the real Agent and persisted stream is replayable", { timeout: 90000 }, async (t) => {
  if (!process.env.OPENAI_BASE_URL || !process.env.OPENAI_API_KEY) return t.skip("Real gateway credential is not configured.");
  const dataDir = await mkdtemp(join(tmpdir(), "nodeforge-nf150-"));
  const port = 31250 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ["scripts/start-control-api.mjs"], { cwd: process.cwd(), env: { ...process.env, NODE_CONTROL_PORT: String(port), NODE_CONTROL_DATA_DIR: dataDir, NODE_AGENT_TIMEOUT_MS: "60000" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { child.kill("SIGTERM"); await rm(dataDir, { recursive: true, force: true }); });
  await waitForOutput(child.stdout, "Node Control API listening", 20000);
  const base = `http://127.0.0.1:${port}`;
  const correlation = "CORR-NF150";
  const sent = await fetch(`${base}/projects/PROJECT-NF150/conversations/CONV-NF150/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message_id: "MSG-NF150", correlation_id: correlation, timestamp: new Date().toISOString(), payload: { text: "Reply with exactly three words: system ready status." } }) });
  assert.equal(sent.status, 202);
  let history;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    history = await fetch(`${base}/projects/PROJECT-NF150/history?conversationId=CONV-NF150&correlationId=${correlation}&limit=100`).then((response) => response.json());
    if (history.items.some((item) => item.type === "architecture.message.received" || item.type === "architecture.error")) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert(history.items.some((item) => item.type === "architecture.message.received"), JSON.stringify(history));
  const deltas = history.items.filter((item) => item.type === "architecture.message.delta");
  assert.equal(deltas.length, 0);
  assert(history.items.every((item) => item.correlation_id === correlation));
  assert.equal(JSON.stringify(history).includes(process.env.OPENAI_API_KEY), false);
  const replay = await fetch(`${base}/projects/PROJECT-NF150/conversations/CONV-NF150/stream?after=${encodeURIComponent("MSG-NF150")}`);
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
