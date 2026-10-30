// Verifies Claude timeout cleanup and OS ownership fences before restoring ticket Resume.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";
import { assertClaudeSessionStopped } from "../../src/modules/agent/claude-session-process.js";
import { confirmTicketSdkTimeout } from "../../src/modules/supervisor/ticket/ticket-sdk-timeout.js";
import { coderProductionRecoveryFixture } from "../fixtures/coder-production-recovery-fixture.js";

test("Claude executor timeout releases its launch and keeps the unfinished verification checkpoint", async () => {
  const f = await coderProductionRecoveryFixture({ provider: "claude", assertSessionStopped: () => {}, behavior: async ({ onSessionReady }) => {
    onSessionReady("SESSION");
    throw Object.assign(new Error("Claude SDK request timed out for CODER."), { code: "SDK_REQUEST_TIMEOUT", provider_outcome: "unknown" });
  } });
  try {
    const result = await f.run({ task_id: "TASK", status: "in_progress", agent_id: "CODER", provider: "claude", session_id: "SESSION",
      last_completed_turn: 81, phase: "verification_report_required", verification_wait: { status: "failed", error_code: "VERIFY_COMMAND_FAILED" } });
    assert.equal(result.status, "failed");
    const checkpoint = await f.checkpoints.load("TASK");
    assert.equal(checkpoint.last_completed_turn, 81);
    assert.equal(checkpoint.session_id, "SESSION");
    assert.equal(checkpoint.failure.resume_allowed, true);
    assert.equal(checkpoint.verification_wait.status, "failed");
    assert.equal(f.statusStore.get().details.launch_claim, undefined);
    assert.equal(f.occupancy.getByTask(), null);
    assert.equal(f.invocations, 1);
  } finally { await f.close(); }
});

test("Claude deadline waits for query cleanup and emits the typed timeout", async () => {
  let closed = false; let returned = false; let request;
  const gateway = createClaudeSdkGateway({ timeoutMs: 10, terminalOutput: { write() {} },
    configuration: { getById: () => ({ agent_id: "CODER", provider: "anthropic", enabled: true, status: "ready", gateway_url: "https://example.test" }) },
    credentialResolver: () => "credential",
    queryFn: ({ options }) => {
      request = options;
      return { async *[Symbol.asyncIterator]() {
        yield await new Promise((_resolve, reject) => options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }, close() { closed = true; }, async return() { assert.equal(closed, true); await new Promise((resolve) => setImmediate(resolve)); returned = true; } };
    } });
  await assert.rejects(gateway.execute({ agentId: "CODER", correlationId: "CORR", prompt: "Work" }), { code: "SDK_REQUEST_TIMEOUT", provider_outcome: "unknown" });
  assert.equal(request.env.FORGE_CLAUDE_AGENT_ID, "CODER");
  assert.equal(returned, true);
});

test("Claude timeout persists the exact request even while shutdown remains unconfirmed", async () => {
  let saved;
  const error = Object.assign(new Error("Claude SDK request timed out for CODER."), { code: "SDK_REQUEST_TIMEOUT", provider_outcome: "unknown" });
  const checkpoint = { task_id: "TASK", agent_id: "CODER", provider: "claude", session_id: "SESSION", status: "in_progress", phase: "verification_report_required", last_completed_turn: 81, verification_wait: { status: "failed" } };
  const input = { error, checkpoint, selected: { agent_id: "CODER", provider: "anthropic" }, requestId: "REQ",
    checkpoints: { save: async (value) => { saved = value; } },
    gateway: { assertSessionStopped: () => { throw Object.assign(new Error("still active"), { code: "EXECUTION_SESSION_BUSY" }); } } };
  assert.equal(await confirmTicketSdkTimeout(input), false);
  assert.equal(saved.failure_request_id, "REQ");
  assert.equal(saved.last_completed_turn, 81);
  assert.deepEqual(saved.verification_wait, checkpoint.verification_wait);
  assert.equal(error.provider_outcome, "unknown");
  assert.equal(await confirmTicketSdkTimeout({ ...input, checkpoints: undefined, gateway: { assertSessionStopped: (identity) => {
    assert.equal(identity.sessionId, "SESSION");
  } } }), true);
  assert.equal(error.resume_allowed, true);
  assert.equal(error.provider_outcome, "failed");
});

test("process probe distinguishes other profiles and sessions while retaining unknown legacy ownership", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "claude-process-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "123"));
  await writeFile(join(root, "123", "cmdline"), "/sdk/claude\0--resume=OTHER\0");
  await writeFile(join(root, "123", "environ"), "FORGE_CLAUDE_AGENT_ID=OTHER\0");
  assert.doesNotThrow(() => assertClaudeSessionStopped("CODER", false, root, "SESSION"));
  assert.throws(() => assertClaudeSessionStopped("CODER", true, root), { code: "EXECUTION_SESSION_BUSY" });
  await writeFile(join(root, "123", "environ"), "FORGE_CLAUDE_AGENT_ID=CODER\0");
  assert.throws(() => assertClaudeSessionStopped("CODER", false, root), { code: "EXECUTION_SESSION_BUSY" });
  await writeFile(join(root, "123", "environ"), "PATH=/usr/bin\0");
  assert.doesNotThrow(() => assertClaudeSessionStopped("CODER", false, root, "SESSION"));
  await writeFile(join(root, "123", "cmdline"), "/sdk/claude\0--resume=SESSION\0");
  assert.throws(() => assertClaudeSessionStopped("CODER", false, root, "SESSION"), { code: "EXECUTION_SESSION_BUSY" });
  await writeFile(join(root, "123", "cmdline"), "/sdk/claude\0");
  assert.throws(() => assertClaudeSessionStopped("CODER", false, root, "SESSION"), { code: "EXECUTION_SESSION_BUSY" });
  const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
  await writeFile(join(root, "stat"), "btime 100\n");
  const fields = Array(20).fill("0"); fields[0] = "S"; fields[19] = String(10 * ticks);
  await writeFile(join(root, "123", "stat"), `123 (claude worker) ${fields.join(" ")}`);
  assert.doesNotThrow(() => assertClaudeSessionStopped("CODER", false, root, "SESSION", new Date(105000).toISOString()));
  await writeFile(join(root, "123", "cmdline"), "/sdk/claude\0--resume=SESSION\0");
  assert.throws(() => assertClaudeSessionStopped("CODER", false, root, "SESSION", new Date(105000).toISOString()), { code: "EXECUTION_SESSION_BUSY" });
  await writeFile(join(root, "123", "cmdline"), "/sdk/claude\0");
  fields[19] = String(ticks);
  await writeFile(join(root, "123", "stat"), `123 (claude worker) ${fields.join(" ")}`);
  assert.throws(() => assertClaudeSessionStopped("CODER", false, root, "SESSION", new Date(105000).toISOString()), { code: "EXECUTION_SESSION_BUSY" });
});
