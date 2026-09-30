// Exercises ticket dispatch through a real configured provider on an isolated Control API project.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { inspectRootCoderCanary, waitForCoderReport } from "./root-coder-provider-evidence.js";
const execFile = promisify(execFileCallback);
const projectId = "PROJECT-REAL-PROVIDER-WITNESS";
const ticketId = "TICKET-REAL-PROVIDER-WITNESS";
const sourceRoot = resolve(".");
// Reserves a loopback port for one disposable Control API process.
async function freePort() {
  const listener = createServer();
  await new Promise((done) => listener.listen(0, "127.0.0.1", done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  return port;
}
// Starts the production composition with fixture-specific storage and no inherited provider keys.
async function startApi(root, port) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_CONTROL_PROJECT_ROOT: root, NODE_CONTROL_DATA_DIR: join(root, ".forge/runtime/nf"), NODE_CONTROL_PROJECT_ID: projectId, NODE_CONTROL_PORT: String(port), NODE_CONTROL_HOST: "127.0.0.1", NODE_SECRET_ENCRYPTION_KEY: "disposable-real-provider-fixture-key", NODE_SDK_AGENT_TIMEOUT_MS: "600000", NODEFORGE_ENV_FILE: join(root, "no-deployment-env"), ...(process.env.NODEFORGE_REAL_PROVIDER_ROOT_ONLY === "1" || process.env.NODEFORGE_REAL_PROVIDER_ROOT_CODER === "1" ? { NODEFORGE_TICKET_EXECUTION_MODE: "root-only" } : {}) };
  const child = spawn(process.execPath, [join(sourceRoot, "backend/scripts/start-control-api.mjs")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000); });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Production Control API startup timed out.")), 20_000);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-1000); if (output.includes("Node Control API listening")) { clearTimeout(timer); done(); } });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Production Control API exited ${code}: ${diagnostics}`)); });
  });
  return child;
}
// Stops only this test-owned API and bounds shutdown waits.
async function stopApi(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Disposable Control API shutdown timed out.")), 10_000);
    child.once("exit", () => { clearTimeout(timer); done(); });
  });
}
// Sends a structured Forge request while retaining the public error envelope for assertions.
async function request(base, method, path, body) {
  const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(240_000) });
  return { status: response.status, body: await response.json() };
}
// Waits for a passed artifact persisted by the real provider ticket run.
async function waitForArtifact(root) {
  const contextRoot = join(root, ".forge/runtime/ticket-execution-contexts");
  const artifactRoot = join(root, ".forge/runtime/ticket-verification", ticketId, "artifacts");
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const contextRoots = await readdir(contextRoot).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    if (contextRoots.length) {
      const contextPath = join(contextRoot, contextRoots[0], `${ticketId}.json`);
      const context = await readFile(contextPath, "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (context?.verification_artifact_id) {
        const artifact = JSON.parse(await readFile(join(artifactRoot, `${context.verification_artifact_id}.json`), "utf8"));
        assert.equal(artifact.status, "passed");
        return { context, artifact };
      }
    }
    const artifacts = await readdir(artifactRoot).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    for (const file of artifacts) {
      const artifact = JSON.parse(await readFile(join(artifactRoot, file), "utf8"));
      if (artifact.status === "failed") throw new Error(`Provider verification failed: ${JSON.stringify(artifact.commands.map(({ kind, exit_code, stdout_redacted, stderr_redacted }) => ({ kind, exit_code, stdout_redacted, stderr_redacted })))}`);
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  const checkpointPath = join(root, ".forge/runtime/agent-checkpoints", `${ticketId}.json`);
  const checkpoint = await readFile(checkpointPath, "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  throw new Error(`Real provider did not produce a passed artifact within six minutes: ${JSON.stringify({ status: checkpoint?.status ?? null, turn: checkpoint?.last_completed_turn ?? null, last_tool: checkpoint?.last_tool ?? null, failure_code: checkpoint?.failure?.code ?? null })}`);
}
// Waits for a reviewed integration receipt after the restarted production API resumes the ticket.
async function waitForIntegration(root) {
  const receiptPath = join(root, ".forge/runtime/ticket-integrations", `${ticketId}.json`);
  const reviewPath = join(root, ".forge/runtime/reviewer-checkpoints", `${ticketId}.json`);
  let reviewStatus = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const receipt = await readFile(receiptPath, "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    const review = await readFile(reviewPath, "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    reviewStatus = review ? { status: review.status, verdict: review.verdict, reviewer_id: review.reviewer_id ?? null, artifact_id: review.verification?.artifact_id ?? null, last_error: review.last_error?.code ?? null } : null;
    if (receipt?.status === "completed" && reviewStatus?.status === "completed" && reviewStatus.verdict === "approved") return { receipt, reviewStatus };
    await new Promise((done) => setTimeout(done, 1000));
  }
  const logPath = join(root, ".forge/runtime/nf/project.log");
  const log = await readFile(logPath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  const events = log.trim().split("\n").slice(-100).flatMap((line) => {
    try { const event = JSON.parse(line); return event.task_id === ticketId ? [{ name: event.event_name, status: event.status, code: event.error_code ?? null }] : []; }
    catch (error) { return [{ name: "malformed_log", status: "failed", code: error.name }]; }
  }).slice(-12);
  throw new Error(`Reviewer/integration did not complete after restart: ${JSON.stringify({ reviewStatus, events })}`);
}
// Waits for the approved ticket to reach a durable terminal context and release both agent claims.
async function waitForTerminal(root) {
  const contextRoot = join(root, ".forge/runtime/ticket-execution-contexts");
  const contextHash = (await readdir(contextRoot))[0];
  const contextPath = join(contextRoot, contextHash, `${ticketId}.json`);
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime/nf"), runtimeDir: "." });
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const context = JSON.parse(await readFile(contextPath, "utf8"));
      const claims = database.all("SELECT role, released_at FROM agent_occupancy WHERE task_id = ?", [ticketId]);
      if (context.state === "terminal" && claims.some((claim) => claim.role === "coder") && claims.every((claim) => claim.released_at !== null)) return { context, claims };
      await new Promise((done) => setTimeout(done, 1000));
    }
    throw new Error("Approved ticket did not reach terminal state with released claims.");
  } finally { await database.close(); }
}

// Waits for every production event comparison and returns only redacted identity receipts.
async function waitForShadowReceipts(root, artifact, reviewedCommit, required = ["verification.passed", "review.approved", "task.completed"]) {
  const projectHash = createHash("sha256").update(projectId).digest("hex");
  const directory = join(root, ".forge/runtime/ticket-pipeline-shadow", projectHash);
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const names = await readdir(directory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const records = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const raw = await readFile(join(directory, name), "utf8");
      const receipt = JSON.parse(raw);
      if (receipt.task_id === ticketId) records.push({ ...receipt, receipt_sha256: createHash("sha256").update(raw).digest("hex") });
    }
    if (required.every((type) => records.some((record) => record.event_type === type))) {
      for (const type of required) {
        const matching = records.filter((record) => record.event_type === type);
        assert.ok(matching.some((record) => record.status === "match"), `${type}: ${JSON.stringify(matching.map(({ status, checks }) => ({ status, checks })))}`);
        assert.ok(matching.every((record) => record.identity.artifact_id === artifact.artifact_id && record.identity.review_commit_sha === reviewedCommit));
      }
      return records.map(({ event_id, event_type, status, receipt_sha256 }) => ({ event_id, event_type, status, receipt_sha256 }));
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  const log = await readFile(join(root, ".forge/runtime/nf/project.log"), "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  const shadowLog = log.split("\n").filter((line) => line.includes("pipeline_shadow")).map((line) => {
    try { const entry = JSON.parse(line); return { event_name: entry.event_name, error_code: entry.error_code, payload: entry.payload }; }
    catch (error) { return { parse_error: error.name }; }
  });
  throw new Error(`Production shadow receipts missing: ${JSON.stringify({ required, shadowLog })}`);
}

// Creates a minimal ticket project with the role contracts required by the real Coder and Reviewer.
async function createProject(root) {
  await mkdir(join(root, "workflows/agents"), { recursive: true });
  await mkdir(join(root, "vocabulary"), { recursive: true });
  await mkdir(join(root, "backend/src"), { recursive: true });
  await mkdir(join(root, "backend/tests/unit"), { recursive: true });
  await mkdir(join(root, "eslint-rules"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".forge/\nnode_modules/\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await writeFile(join(root, "jsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: false, noEmit: true }, include: ["backend/src/**/*.js"] }));
  await writeFile(join(root, "backend/src/witness.js"), "// Holds the disposable ticket value for a real provider verification witness.\nexport const witness = 'Baseline';\n");
  await writeFile(join(root, "backend/tests/unit/witness.test.js"), "// Verifies that the disposable ticket source remains importable after a provider edit.\nimport assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { witness } from '../../src/witness.js';\ntest('witness is text', () => assert.equal(typeof witness, 'string'));\n");
  for (const path of ["AGENTS.md", ".eslintrc.json", "eslint-rules/package.json", "eslint-rules/no-silent-catch.js", "vocabulary/glossary.md", "workflows/agents/coder.md", "workflows/agents/reviewer.md", "workflows/agents/sprint-leader.md"]) await writeFile(join(root, path), await readFile(join(sourceRoot, path)));
  await execFile("git", ["init", root]);
  await execFile("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await execFile("git", ["-C", root, "config", "user.name", "NodeForge Test"]);
  await execFile("git", ["-C", root, "add", "."]);
  await execFile("git", ["-C", root, "commit", "-m", "Baseline"]);
  await symlink(join(sourceRoot, "node_modules"), join(root, "node_modules"), "dir");
}

// Calls the live provider through the real Coder profile and inspects durable evidence without approving it locally.
test("real provider ticket dispatch persists an artifact across Control API restart", { timeout: 1_200_000 }, async (t) => {
  if (process.env.NODEFORGE_REAL_PROVIDER_WITNESS !== "1") return t.skip("Set NODEFORGE_REAL_PROVIDER_WITNESS=1 for an explicit live provider run.");
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_BASE_URL) return t.skip("Live Codex gateway credentials are unavailable.");
  const root = join(await mkdtemp(join(tmpdir(), "nodeforge-real-provider-")), "project");
  let child;
  let completed = false;
  try {
    await createProject(root);
    const port = await freePort();
    child = await startApi(root, port);
    const base = `http://127.0.0.1:${port}`;
    const gateway = process.env.OPENAI_BASE_URL;
    const coderOnly = process.env.NODEFORGE_REAL_PROVIDER_ROOT_CODER === "1";
    for (const [role, agentId] of coderOnly ? [["coder", "a1111111-1111-4111-8111-111111111111"]] : [["coder", "a1111111-1111-4111-8111-111111111111"], ["reviewer", "a2222222-2222-4222-8222-222222222222"]]) {
      const created = await request(base, "POST", "/forge/v1/agents", { agent_id: agentId, agent_name: `${role} fixture`, role, provider: "codex", model: "gpt-6-sol", gateway_url: gateway, api_key: process.env.OPENAI_API_KEY, enabled: true, status: "ready" });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }
    const ticket = await request(base, "POST", `/forge/v1/tickets?project=${projectId}`, { ticket: { id: ticketId, title: "Update disposable backend witness", objective: "Change the named ESM export witness in backend/src/witness.js to 'Real provider witness'. Preserve the export style and use only Forge tools.", acceptance_criteria: ["backend/src/witness.js keeps its named ESM export and exports witness as 'Real provider witness'."], style: ["backend"] } });
    assert.equal(ticket.status, 201, JSON.stringify(ticket.body));
    const dispatch = fetch(`${base}/forge/v1/tickets/${ticketId}:run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId }) }).then(async (response) => ({ status: response.status, body: await response.json() })).catch((error) => ({ interrupted: error.code ?? error.name }));
    if (coderOnly) {
      await waitForCoderReport(root, ticketId);
      await stopApi(child);
      child = null;
      await dispatch;
      t.diagnostic(JSON.stringify(await inspectRootCoderCanary(root, ticketId)));
      completed = true;
      return;
    }
    const before = await waitForArtifact(root);
    assert.equal(before.context.task_id, ticketId);
    assert.equal(before.artifact.commit_sha, before.context.review_commit_sha);
    assert.equal(before.artifact.manifest_sha, before.context.manifest_sha);
    assert.equal(before.artifact.source_revision, before.context.source_revision);
    await waitForShadowReceipts(root, before.artifact, before.context.review_commit_sha, ["verification.passed"]);
    await stopApi(child);
    await dispatch;
    let advancedHeadSha = null;
    if (process.env.NODEFORGE_REAL_PROVIDER_ADVANCED_HEAD === "1") { await writeFile(join(root, "README.md"), "Out-of-ticket change after verification.\n"); await execFile("git", ["-C", root, "add", "README.md"]); await execFile("git", ["-C", root, "commit", "-m", "Advance HEAD outside ticket"]); advancedHeadSha = (await execFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(); }
    child = await startApi(root, port);
    assert.equal((await request(base, "GET", "/forge/v1/health")).status, 200);
    const after = await waitForArtifact(root);
    assert.equal(after.artifact.artifact_id, before.artifact.artifact_id);
    assert.equal(after.context.review_commit_sha, before.context.review_commit_sha);
    const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime/nf"), runtimeDir: "." });
    try {
      const claims = database.all("SELECT claim_id, role, released_at FROM agent_occupancy WHERE task_id = ?", [ticketId]);
      t.diagnostic(JSON.stringify({ package_id: "A1", project_id: projectId, task_id: ticketId, artifact_id: after.artifact.artifact_id, context_revision: after.context.version, manifest_sha: after.context.manifest_sha, base_sha: after.context.base_sha, source_revision: after.context.source_revision, review_commit_sha: after.context.review_commit_sha, state: after.context.state, active_claim_id: claims.find((claim) => claim.role === "coder" && claim.released_at === null)?.claim_id }));
    } finally { await database.close(); }
    if (process.env.NODEFORGE_REAL_PROVIDER_FULL === "1") {
      const resumeController = new AbortController();
      const resumeRequest = fetch(`${base}/forge/v1/tickets/${ticketId}:run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId }), signal: resumeController.signal }).then(async (response) => ({ status: response.status, body: await response.json() })).catch((error) => ({ interrupted: error.code ?? error.name }));
      let resumed;
      try { resumed = await waitForIntegration(root); }
      catch (error) { resumeController.abort(); throw error; }
      const { receipt, reviewStatus } = resumed;
      assert.equal(receipt.reviewed_commit, (await waitForArtifact(root)).artifact.commit_sha);
      if (process.env.NODEFORGE_REAL_PROVIDER_ROOT_ONLY === "1") assert.equal(receipt.workspace_mode, "root-only");
      assert.equal(reviewStatus.reviewer_id, "a2222222-2222-4222-8222-222222222222");
      assert.equal(reviewStatus.artifact_id, before.artifact.artifact_id);
      const terminal = await waitForTerminal(root);
      const shadowReceipts = await waitForShadowReceipts(root, before.artifact, receipt.reviewed_commit);
      assert.equal((await execFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(), advancedHeadSha ?? receipt.commit);
      if (advancedHeadSha) { assert.notEqual(advancedHeadSha, receipt.commit); assert.equal((await execFile("git", ["-C", root, "diff", "--name-only", receipt.commit, advancedHeadSha])).stdout.trim(), "README.md"); assert.equal((await readFile(join(root, ".forge/runtime/nf/project.log"), "utf8")).includes('"error_code":"REVIEW_COMMIT_STALE"'), false); t.diagnostic(JSON.stringify({ package_id: "A2", phase: "advanced_head_review", reviewed_commit: receipt.commit, advanced_head: advancedHeadSha, artifact_id: before.artifact.artifact_id, manifest_sha: before.context.manifest_sha, receipt_status: receipt.status, review_status: reviewStatus.status, review_verdict: reviewStatus.verdict })); }
      resumeController.abort();
      await resumeRequest;
      const duplicateResult = await request(base, "POST", `/forge/v1/tickets/${ticketId}:run`, { project_id: projectId });
      assert.equal(duplicateResult.status, 202);
      assert.equal(duplicateResult.body.status, "accepted");
      assert.equal((await readdir(join(root, ".forge/runtime/ticket-verification", ticketId, "artifacts"))).length, 1);
      assert.equal(JSON.parse(await readFile(join(root, ".forge/runtime/ticket-integrations", `${ticketId}.json`), "utf8")).reviewed_commit, receipt.reviewed_commit);
      t.diagnostic(JSON.stringify({ package_id: "A1", phase: "resumed_review", review_status: reviewStatus, integration_receipt: receipt.status, reviewed_commit: receipt.reviewed_commit, terminal_context: terminal.context.state, released_claim_roles: terminal.claims.map(({ role }) => role), duplicate_dispatch: { status: duplicateResult.status, ticket_status: duplicateResult.body.status } }));
      t.diagnostic(JSON.stringify({ package_id: "A3", shadow_receipts: shadowReceipts }));
    }
    completed = true;
  } finally {
    await stopApi(child);
    if (!completed && process.env.NODEFORGE_REAL_PROVIDER_PRESERVE_FAILURE === "1") t.diagnostic(`Failed canary fixture retained at ${root}`);
    else await rm(resolve(root, ".."), { recursive: true, force: true });
  }
});
