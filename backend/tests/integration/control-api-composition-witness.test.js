// Starts the production Control API against a disposable project to verify isolated restart and rollout persistence.
import assert from "node:assert/strict";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const entrypoint = resolve("backend/scripts/start-control-api.mjs");

// Allocates a loopback port without touching the user's running API.
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

// Waits for the actual production entrypoint to listen or report its startup error.
async function startApi(root, dataDir, port) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_CONTROL_PROJECT_ROOT: root, NODE_CONTROL_DATA_DIR: dataDir, NODE_CONTROL_PROJECT_ID: "PROJECT-COMPOSITION-WITNESS", NODE_CONTROL_PORT: String(port), NODE_CONTROL_HOST: "127.0.0.1", NODE_SECRET_ENCRYPTION_KEY: "disposable-composition-fixture-key", NODEFORGE_ENV_FILE: join(root, "no-deployment-env"), NODEFORGE_TICKET_EXECUTION_MODE: "root-only" };
  const child = spawn(process.execPath, [entrypoint], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`Control API startup timed out: ${stderr}`)), 15_000);
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-1000); if (output.includes("Node Control API listening")) { clearTimeout(timer); done(); } });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Control API exited ${code}: ${stderr}`)); });
    });
    return child;
  } catch (error) {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await new Promise((done) => child.once("exit", done));
    throw error;
  }
}

// Stops only the disposable child process and verifies graceful shutdown.
async function stopApi(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Control API did not stop after SIGTERM.")), 10_000);
    child.once("exit", () => { clearTimeout(timer); done(); });
  });
}

// Proves the real composition starts on an isolated project and reloads its persisted shadow flag.
test("production Control API composition restarts on a disposable project", { timeout: 40_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "nodeforge-composition-"));
  const root = join(temp, "project");
  const dataDir = join(root, ".forge/runtime/nf");
  let child;
  try {
    await mkdir(root, { recursive: true });
    await mkdir(join(root, "workflows/agents"), { recursive: true });
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "README.md"), "Disposable project\n");
    await writeFile(join(root, "workflows/agents/sprint-leader.md"), await readFile(resolve("workflows/agents/sprint-leader.md")));
    await execFile("git", ["init", root]);
    await execFile("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    await execFile("git", ["-C", root, "config", "user.name", "NodeForge Test"]);
    await execFile("git", ["-C", root, "add", "."]);
    await execFile("git", ["-C", root, "commit", "-m", "Baseline"]);
    const port = await freePort();
    child = await startApi(root, dataDir, port);
    const health = await fetch(`http://127.0.0.1:${port}/forge/v1/health`);
    assert.equal(health.status, 200);
    const projectId = "PROJECT-COMPOSITION-WITNESS";
    const ticketId = "TICKET-COMPOSITION-WITNESS";
    const created = await fetch(`http://127.0.0.1:${port}/forge/v1/tickets?project=${projectId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: { id: ticketId, title: "Change disposable README", objective: "Update README.md in the disposable project.", acceptance_criteria: ["README.md records the test update."], style: ["docs"] } }) });
    assert.equal(created.status, 201, await created.text());
    const dispatch = await fetch(`http://127.0.0.1:${port}/forge/v1/tickets/${ticketId}:run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId }) });
    assert.equal(dispatch.ok, false);
    const blocked = await dispatch.json();
    assert.equal(blocked.error?.code, "agent_not_available", JSON.stringify(blocked));
    assert.equal(await readFile(join(root, "README.md"), "utf8"), "Disposable project\n");
    const flagRoot = join(root, ".forge/runtime/ticket-pipeline-rollout");
    const [name] = await readdir(flagRoot);
    const flag = JSON.parse(await readFile(join(flagRoot, name), "utf8"));
    assert.equal(flag.mode, "shadow");
    await stopApi(child);
    child = await startApi(root, dataDir, port);
    assert.equal((await fetch(`http://127.0.0.1:${port}/forge/v1/health`)).status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(flagRoot, name), "utf8")), flag);
    assert.equal(await readFile(join(root, "README.md"), "utf8"), "Disposable project\n");
  } finally {
    if (child) await stopApi(child);
    await rm(temp, { recursive: true, force: true });
  }
});
