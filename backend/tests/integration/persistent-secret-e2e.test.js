import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("persists a real Agent credential across Node restart and keeps it out of responses", { timeout: 90000 }, async (t) => {
  if (!process.env.OPENAI_BASE_URL || !process.env.OPENAI_API_KEY) return t.skip("Real gateway credential is not configured.");
  const dataDir = await mkdtemp(join(tmpdir(), "nodeforge-nf152-")); const port = 31300 + Math.floor(Math.random() * 100);
  const env = { ...process.env, NODE_CONTROL_PORT: String(port), NODE_CONTROL_DATA_DIR: dataDir, NODE_SECRET_ENCRYPTION_KEY: "nf152-test-encryption-key", NODE_AGENT_TIMEOUT_MS: "60000" };
  let child = start(env); t.after(async () => { child.kill("SIGTERM"); await rm(dataDir, { recursive: true, force: true }); });
  await waitForOutput(child.stdout, "Node Control API listening", 20000);
  const base = `http://127.0.0.1:${port}`;
  const secret = process.env.OPENAI_API_KEY;
  const saved = await request(base, "PUT", "/agents/architecture-manager/settings", { agent_name: "Architecture Manager", gateway_url: `${process.env.OPENAI_BASE_URL.replace(/\/$/, "")}/responses`, enabled: true, api_key: secret });
  assert.equal(saved.api_key_masked, "********"); assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.equal((await request(base, "POST", "/agents/architecture-manager/settings/test")).status, "CONNECTED");
  child.kill("SIGTERM"); await waitForExit(child);
  child = start(env); await waitForOutput(child.stdout, "Node Control API listening", 20000);
  const settings = await request(base, "GET", "/agents/settings");
  assert.equal(settings.find((item) => item.agent_id === "architecture-manager").credential_ref, "env:OPENAI_API_KEY");
  assert.equal(JSON.stringify(settings).includes(secret), false);
  assert.equal((await request(base, "POST", "/agents/architecture-manager/settings/test")).status, "CONNECTED");
  const vault = await readFile(join(dataDir, "secrets.vault"), "utf8"); assert.equal(vault.includes(secret), false);
});

function start(env) { return spawn(process.execPath, ["scripts/start-control-api.mjs"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] }); }
function waitForOutput(stream, text, timeoutMs) { return new Promise((resolve, reject) => { let output = ""; const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${text}`)), timeoutMs); stream.on("data", (chunk) => { output += chunk; if (output.includes(text)) { clearTimeout(timer); resolve(); } }); stream.on("error", (error) => { clearTimeout(timer); reject(error); }); }); }
function waitForExit(child) { return new Promise((resolve) => child.once("exit", resolve)); }
async function request(base, method, path, body) { const response = await fetch(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }); const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result; }
