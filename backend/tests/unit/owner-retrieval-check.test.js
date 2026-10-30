// Verifies that System Engineer can run the canonical retrieval benchmark through Forge
// and receive its unmodified verification receipt within bounded service and transport deadlines.
// Uses an injected orchestrator and SDK to check routing, cancellation, and transport configuration;
// this fixture does not claim that the real retrieval benchmark completes successfully.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerEngineerTools } from "../../src/tools/roles/owner-engineer-tools.js";
import { createTestService } from "../../src/application/test-service.js";
import { createTestCodexSdkGateway } from "../fixtures/codex-sdk-fixture.js";

// Preserves success and failure receipts while forwarding the benchmark through the real service boundary.
test("retrieval check uses the ten-minute service deadline and preserves final receipts", async () => {
  for (const status of ["passed", "failed"]) {
    const calls = [];
    const receipt = { status, run_id: `RETRIEVAL-${status}`, breakdown: [{ kind: "test", status, exit_code: status === "passed" ? 0 : 1 }] };
    const testService = createTestService({ verificationOrchestrator: { run: async (plan, options) => { calls.push({ plan, options }); return receipt; } } });
    const { implementations } = createOwnerEngineerTools({ testService });
    const controller = new AbortController();
    const result = await implementations.run_check.execute({ type: "test", command: "pnpm --dir backend eval:retrieval" },
      { conversation_id: "CONV-RETRIEVAL", correlation_id: "CORR-RETRIEVAL", abortSignal: controller.signal });
    assert.equal(result.run_id, receipt.run_id);
    assert.equal(result.status, status);
    assert.deepEqual(result.breakdown, receipt.breakdown);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].plan.checks[0].command, "pnpm --dir backend eval:retrieval");
    assert.equal(calls[0].plan.checks[0].timeout_ms, 600_000);
    assert.equal(calls[0].options.timeoutMs, 600_000);
    assert.equal(calls[0].options.signal.aborted, false);
  }
});

// Rejects lookalike scripts, directory escapes, extra arguments and shell syntax before any service call.
test("retrieval allowance is restricted to the exact backend benchmark and test check type", async () => {
  const { implementations } = createOwnerEngineerTools({ testService: { runCheck: async () => assert.fail("Invalid command reached verification") } });
  const commands = [
    "pnpm --dir backend eval:retrieval-other",
    "pnpm --dir backend eval:retrieval --limit=1",
    "pnpm --dir ui/nextjs eval:retrieval",
    "pnpm --dir ../backend eval:retrieval",
    "pnpm --dir backend eval:retrieval; id",
    "pnpm --dir backend eval:retrieval && id",
    "pnpm --dir backend eval:retrieval\nnode evil.js",
    "pnpm --dir backend eval:backfill"
  ];
  for (const command of commands) {
    await assert.rejects(() => implementations.run_check.execute({ type: "test", command }, { conversation_id: "CONV-RETRIEVAL" }), { code: "INPUT_INVALID" });
  }
  for (const type of ["build", "lint", "typecheck"]) {
    await assert.rejects(() => implementations.run_check.execute({ type, command: "pnpm --dir backend eval:retrieval" }, { conversation_id: "CONV-RETRIEVAL" }), { code: "INPUT_INVALID" });
  }
});

// Gives synchronous verification room to return its receipt without extending the configured SDK session.
// Ordinary discovery and existing report completion retain their established timeout behavior.
test("Codex verification transport waits eleven minutes and respects shorter session deadlines", async () => {
  for (const { names, timeoutMs, expected } of [
    { names: ["run_check"], timeoutMs: 900_000, expected: 660 },
    { names: ["run_check"], timeoutMs: 600_000, expected: 600 },
    { names: ["run_check"], timeoutMs: 90_000, expected: 90 },
    { names: ["search_text"], timeoutMs: 600_000, expected: 120 },
    { names: ["report_done", "run_check"], timeoutMs: 600_000, expected: 600 }
  ]) {
    let config;
    const gateway = createTestCodexSdkGateway({ timeoutMs,
      configuration: { getById: () => ({ agent_id: "retrieval-check", gateway_url: "https://gateway.test", credential_ref: "secret", enabled: true, status: "ready" }) },
      credentialResolver: () => "fixture-key", terminalOutput: { write() {} },
      CodexClass: class {
        constructor(options) { config = options.config; }
        startThread() { return { runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed" }; })() }) }; }
      }
    });
    await gateway.execute({ agentId: "retrieval-check", prompt: "Run retrieval check", correlationId: "RETRIEVAL",
      options: { forgeTools: {
        registry: Object.fromEntries(names.map((name) => [name, { execute: async () => ({}) }])),
        definitions: names.map((name) => ({ name, input_schema: { type: "object", properties: {} } }))
      } }
    });
    assert.equal(config.mcp_servers.forge.tool_timeout_sec, expected);
    assert.deepEqual(config.mcp_servers.forge.enabled_tools, names);
  }
});
